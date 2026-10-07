import { createConnection, createServer, type Server } from 'node:net';

/** The proxy socket the cell manager binds into this cell, and the address clients use. */
export const PROXY_SOCKET = '/run/anchi/proxy.sock';
export const PROXY_PORT = 3128;

/**
 * Relays 127.0.0.1:3128 to the cell's proxy socket. The cell has loopback-only networking, so
 * this is the only way out; it is a convenience for HTTP_PROXY-aware clients, not a boundary.
 */
export function startForwarder(socketPath = PROXY_SOCKET, port = PROXY_PORT): Promise<Server> {
  const server = createServer((client) => {
    const upstream = createConnection(socketPath);
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', close);
    upstream.on('error', close);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
