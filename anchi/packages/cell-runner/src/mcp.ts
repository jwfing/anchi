import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { availableConnectorTools, callConnector, type ConnectorTool } from './connectors.ts';
import { TOOLS_SOCKET } from './paths.ts';

/**
 * The Anchi MCP server inside a cell: a stdio MCP server the runtime starts. It holds nothing
 * and decides nothing; every call goes to the runner's tool socket and from there to the
 * daemon, which knows the task and agent and checks what the call may do.
 *
 * Only the parts of MCP a tool server needs: initialize, tools/list, tools/call and ping.
 */

type Json = Record<string, unknown>;
type Call = (tool: string, args: Json) => Promise<{ ok: boolean; result?: Json; error?: string }>;

const LIST_TOOLS = 'anchi.tools';
const APPROVAL_PENDING = 'anchi.approval_pending';

/** Connector tools served in the cell itself (through the bound service sockets). */
export interface LocalTools {
  list(): ConnectorTool[];
  run(tool: ConnectorTool, args: Json, onApproval: (id: string) => void): Promise<Json>;
}

export const connectorTools: LocalTools = {
  list: () => availableConnectorTools(),
  run: (tool, args, onApproval) => callConnector(tool, args, { onApproval }),
};
const SERVER_INFO = { name: 'anchi', version: '1' };
const DEFAULT_PROTOCOL = '2025-06-18';

/** One request over the runner's tool socket. */
export function socketCall(path = TOOLS_SOCKET): Call {
  return (tool, args) =>
    new Promise((resolve) => {
      const conn = createConnection(path, () => conn.write(`${JSON.stringify({ tool, args })}\n`));
      let buffer = '';
      conn.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const nl = buffer.indexOf('\n');
        if (nl < 0) return;
        conn.end();
        try {
          resolve(JSON.parse(buffer.slice(0, nl)) as Awaited<ReturnType<Call>>);
        } catch {
          resolve({ ok: false, error: 'bad answer from the runner' });
        }
      });
      conn.on('error', (err) =>
        resolve({ ok: false, error: `Anchi is unreachable: ${err.message}` }),
      );
    });
}

/** Answers one JSON-RPC message; returns undefined for notifications. */
export async function handle(
  message: Json,
  call: Call,
  local: LocalTools = connectorTools,
): Promise<Json | undefined> {
  const { id, method } = message;
  const params = (message.params ?? {}) as Json;
  if (id === undefined || id === null) return undefined; // notifications need no answer
  const reply = (result: Json) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, msg: string) => ({
    jsonrpc: '2.0',
    id,
    error: { code, message: msg },
  });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion:
          typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return reply({});
    case 'tools/list': {
      const r = await call(LIST_TOOLS, {});
      if (!r.ok) return fail(-32603, r.error ?? 'cannot list tools');
      const connectors = local
        .list()
        .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
      return reply({ tools: [...((r.result?.tools as unknown[]) ?? []), ...connectors] });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Json;
      const connectorTool = local.list().find((t) => t.name === name);
      if (connectorTool) {
        // Best effort: lets the daemon show the approval in the TUI while the service waits.
        const onApproval = (id: string) =>
          void call(APPROVAL_PENDING, { connector: connectorTool.connector, approval_id: id });
        try {
          const result = await local.run(connectorTool, args, onApproval);
          return reply({
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
            isError: false,
          });
        } catch (err) {
          return reply({
            content: [{ type: 'text', text: (err as Error).message }],
            isError: true,
          });
        }
      }
      const r = await call(name, args);
      return reply({
        content: [
          { type: 'text', text: r.ok ? JSON.stringify(r.result ?? {}) : (r.error ?? 'failed') },
        ],
        ...(r.ok ? { structuredContent: r.result ?? {} } : {}),
        isError: !r.ok,
      });
    }
    default:
      return fail(-32601, `method not found: ${String(method)}`);
  }
}

/** Serves MCP over stdin and stdout, one JSON message per line. */
export function serveMcp(call: Call = socketCall()): void {
  const write = (m: Json) => process.stdout.write(`${JSON.stringify(m)}\n`);
  createInterface({ input: process.stdin }).on('line', (line) => {
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    void handle(message, call).then((answer) => answer && write(answer));
  });
}
