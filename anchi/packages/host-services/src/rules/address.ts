/**
 * Destinations the proxy never connects to: every range the VM's kernel backstop lists for the
 * proxy's user (services/network_rules.py), and every address Python's `ipaddress` calls not
 * global, multicast, reserved or link-local. IPv4-mapped and NAT64 addresses would reach a
 * private IPv4 host through IPv6, so they are in the lists too.
 */

export const PRIVATE_V4 =
  '0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, ' +
  '192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/3';
export const PRIVATE_V6 =
  '::/127, ::ffff:0:0/96, 64:ff9b::/96, 100::/64, 2001:db8::/32, fc00::/7, fe80::/10, ff00::/8';
// What `ipaddress` additionally refuses as not global or reserved, beyond the lists above.
const NOT_GLOBAL_V4 = '192.88.99.0/24, 240.0.0.0/4';
const NOT_GLOBAL_V6 = '64:ff9b:1::/48, 2001::/23, 2002::/16';

export interface Address {
  version: 4 | 6;
  value: bigint;
}

interface Network extends Address {
  bits: number;
}

export function parseIp(text: string): Address | null {
  const plain = text.split('%', 1)[0]!;
  if (plain.includes(':')) {
    const value = parseV6(plain);
    return value === null ? null : { version: 6, value };
  }
  const value = parseV4(plain);
  return value === null ? null : { version: 4, value };
}

function parseV4(text: string): bigint | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseV6(text: string): bigint | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(text) || text.includes(':::')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): bigint[] | null => {
    if (part === '') return [];
    const items = part.split(':');
    const out: bigint[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.includes('.')) {
        // An embedded IPv4 address ends the list.
        if (i !== items.length - 1) return null;
        const v4 = parseV4(item);
        if (v4 === null) return null;
        out.push(v4 >> 16n, v4 & 0xffffn);
        continue;
      }
      if (!/^[0-9A-Fa-f]{1,4}$/.test(item)) return null;
      out.push(BigInt(parseInt(item, 16)));
    }
    return out;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<bigint>(missing).fill(0n), ...tail];
  let value = 0n;
  for (const group of all) value = (value << 16n) | group;
  return value;
}

function network(text: string): Network {
  const [address, bits] = text.trim().split('/');
  const parsed = parseIp(address!);
  if (parsed === null) throw new Error(`bad network ${text}`);
  return { ...parsed, bits: Number(bits) };
}

const PRIVATE_NETWORKS: readonly Network[] = [
  ...PRIVATE_V4.split(','),
  ...NOT_GLOBAL_V4.split(','),
  ...PRIVATE_V6.split(','),
  ...NOT_GLOBAL_V6.split(','),
].map(network);

function inNetwork(ip: Address, net: Network): boolean {
  if (ip.version !== net.version) return false;
  const width = BigInt(net.version === 4 ? 32 : 128);
  const shift = width - BigInt(net.bits);
  return ip.value >> shift === net.value >> shift;
}

/** Whether the proxy must not connect to `ip`. */
export function privateDestination(ip: Address): boolean {
  if (ip.version === 4 && ip.value === 0xffffffffn) return true;
  return PRIVATE_NETWORKS.some((net) => inNetwork(ip, net));
}

export interface ResolvedAddress {
  family: 4 | 6;
  address: string;
}

/**
 * The first address if every one is public, else [null, reason]. The proxy connects to the
 * returned address itself, so a second resolution (DNS rebinding) cannot change the
 * destination after the check. IPv4 is preferred where both families answer.
 */
export function publicAddress(infos: readonly ResolvedAddress[]): [string | null, string | null] {
  let chosen: Address | null = null;
  let chosenText = '';
  for (const info of infos) {
    const ip = parseIp(String(info.address));
    if (ip === null) return [null, 'unparsable address'];
    if (privateDestination(ip)) return [null, `non-public destination ${info.address}`];
    if (chosen === null || (chosen.version === 6 && ip.version === 4)) {
      chosen = ip;
      chosenText = String(info.address).split('%', 1)[0]!;
    }
  }
  if (chosen === null) return [null, 'no address'];
  return [chosenText, null];
}

/** The first address of each listed range, for the test that the proxy refuses them all. */
export function listedRanges(): string[] {
  return [...PRIVATE_V4.split(','), ...PRIVATE_V6.split(',')].map((t) => t.trim().split('/')[0]!);
}
