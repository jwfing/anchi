import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { afterEach, expect, it } from 'vitest';
import { homeLayout } from '@anchi/core';
import { PeerNetwork } from '../src/peer-network.ts';
import { Store } from '../src/store.ts';

const nodes: PeerNetwork[] = [];
const stores: Store[] = [];
const identities = new Map<string, { key: Buffer; cert: string }>();
async function node(label: string) {
  const layout = homeLayout(mkdtempSync(join(tmpdir(), 'anchi-peer-')));
  const store = new Store(join(layout.dataDir, 'anchi.db'));
  stores.push(store);
  const network = new PeerNetwork({
    layout,
    store,
    agents: () => [],
    handle: async () => null,
    intervalMs: 20,
  });
  nodes.push(network);
  await network.configure({ label, listen: '127.0.0.1', port: 0, address: 'tls://127.0.0.1:0' });
  identities.set(network.node, {
    key: readFileSync(join(layout.root, 'peers/identity/tls.key')),
    cert: network.identity().certificate,
  });
  return network;
}

async function rawRequest(server: PeerNetwork, client?: PeerNetwork): Promise<void> {
  const record = server.identity();
  const socket = connect({
    host: '127.0.0.1',
    port: Number(new URL(record.address).port),
    ca: record.certificate,
    servername: `anchi-${record.node}`,
    ...(client ? identities.get(client.node) : {}),
    rejectUnauthorized: true,
    minVersion: 'TLSv1.3',
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.setTimeout(2000, () => socket.destroy(new Error('TLS test timed out')));
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('connection closed')));
      socket.once('data', () => resolve());
      socket.once('secureConnect', () =>
        socket.write(JSON.stringify({ id: 1, method: 'task.poll', params: {} }) + '\n'),
      );
    });
  } finally {
    socket.destroy();
  }
}

afterEach(async () => {
  await Promise.all(nodes.splice(0).map((n) => n.stop()));
  for (const store of stores.splice(0)) store.close();
  identities.clear();
});

it('rejects missing, unpaired and revoked client certificates in the TLS handshake', async () => {
  const a = await node('a');
  const b = await node('b');
  await a.stop();
  await expect(rawRequest(b)).rejects.toThrow(/alert/i);
  await expect(rawRequest(b, a)).rejects.toThrow();
  b.admit(a.identity());
  await expect(rawRequest(b, a)).resolves.toBeUndefined();
  b.remove(a.node);
  await expect(rawRequest(b, a)).rejects.toThrow();
});

it('rejects a different server certificate at a paired address during TLS validation', async () => {
  const a = await node('a');
  const b = await node('b');
  const impostor = await node('impostor');
  await b.configure({
    label: 'b',
    listen: '127.0.0.1',
    port: 0,
    address: impostor.identity().address,
  });
  impostor.admit(a.identity());
  a.admit(b.identity());
  await expect(a.request(b.node, 'task.poll', {})).rejects.toThrow(/self.signed certificate/i);
});

it('refuses an unpaired node and never exposes owner administration on a peer connection', async () => {
  const a = await node('a');
  const b = await node('b');
  a.admit(b.identity());
  await expect(a.request(b.identity().node, 'task.poll', {})).rejects.toThrow();
  b.admit(a.identity());
  await expect
    .poll(() => a.directory().nodes.find((n) => n.node === b.identity().node)?.online)
    .toBe(true);
  await expect(a.request(b.identity().node, 'daemon.shutdown', {})).rejects.toThrow(
    'PEER_METHOD_DENIED',
  );
});

it('rejects a directory forged under another node identity', async () => {
  const a = await node('a');
  const b = await node('b');
  a.admit(b.identity());
  b.admit(a.identity());
  await expect
    .poll(() => a.directory().nodes.find((n) => n.node === b.identity().node)?.online)
    .toBe(true);
  const forged = { ...a.identity(), node: b.identity().node };
  await expect(
    a.request(b.identity().node, 'peer.sync', { records: [forged], removed: [] }),
  ).rejects.toThrow();
  expect(b.identity().label).toBe('b');
});

it('discovers peers transitively and keeps the two remaining nodes connected without the seed', async () => {
  const a = await node('a');
  const b = await node('b');
  const c = await node('c');
  a.admit(b.identity());
  b.admit(a.identity());
  a.admit(c.identity());
  c.admit(a.identity());
  await expect.poll(() => b.directory().nodes.filter((n) => n.online).length).toBe(3);
  await a.stop();
  await expect
    .poll(() => b.directory().nodes.find((n) => n.node === c.identity().node)?.online)
    .toBe(true);
  const synced = await b.request(c.identity().node, 'peer.sync', { records: [], removed: [] });
  expect(synced).toBeDefined();
});

it('propagates removal and refuses reintroduction from an old directory snapshot', async () => {
  const a = await node('a');
  const b = await node('b');
  const c = await node('c');
  a.admit(b.identity());
  b.admit(a.identity());
  a.admit(c.identity());
  c.admit(a.identity());
  await expect.poll(() => b.directory().nodes.length).toBe(3);
  const old = c.identity();
  a.remove(old.node);
  await expect.poll(() => b.directory().nodes.some((n) => n.node === old.node)).toBe(false);
  expect(() => b.admit(old)).toThrow('PEER_REVOKED');
});
