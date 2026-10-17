import { promises as dns } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

/**
 * SSRF protection for webhook URLs (docs/04-security.md §4.8).
 *
 * Checked at registration AND at delivery. At delivery the check happens inside
 * the HTTP client's DNS lookup, so the address that was checked is exactly the
 * address that gets connected to (no DNS-rebinding gap between check and connect).
 */

export type HostResolver = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;

export const systemResolver: HostResolver = async (hostname) =>
  (await dns.lookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) blocked.addSubnet(net, prefix, 'ipv6');

// Note: an '::ffff:0:0/96' rule can't be used here, because BlockList also matches IPv4 addresses against IPv6
// rules (as mapped addresses), so it would block every IPv4 address. Mapped addresses are unwrapped instead.
function embeddedIPv4(ipv6: string): string | null {
  const m = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(ipv6);
  if (!m) return null;
  if (m[1]) return m[1];
  const hi = parseInt(m[2]!, 16);
  const lo = parseInt(m[3]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true; // not an IP: refuse rather than guess
  if (family === 6) {
    const v4 = embeddedIPv4(address);
    if (v4) return blocked.check(v4, 'ipv4');
  }
  return blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/**
 * Validates a webhook URL. WHATWG URL parsing normalises alternative IPv4
 * forms (2130706433, 0x7f.1) to dotted form before the address check.
 */
export async function assertSafeWebhookUrl(raw: string, options: { allowInsecure: boolean; resolver: HostResolver }): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('must be a valid absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UnsafeUrlError('must use https');
  if (url.username || url.password) throw new UnsafeUrlError('must not contain credentials');
  if (options.allowInsecure) return url;
  if (url.protocol !== 'https:') throw new UnsafeUrlError('must use https');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new UnsafeUrlError('must not point to a private, loopback or reserved address');
    return url;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await options.resolver(host);
  } catch {
    throw new UnsafeUrlError('hostname could not be resolved');
  }
  if (addresses.length === 0) throw new UnsafeUrlError('hostname could not be resolved');
  if (addresses.some((a) => isBlockedAddress(a.address))) {
    throw new UnsafeUrlError('must not point to a private, loopback or reserved address');
  }
  return url;
}

/** A `lookup` for http.request that refuses private addresses (used at delivery time). */
export function safeLookup(resolver: HostResolver): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname).then(
      (addresses) => {
        if (addresses.length === 0) return callback(Object.assign(new Error('DNS lookup failed'), { code: 'ENOTFOUND' }), '', 4);
        if (addresses.some((a) => isBlockedAddress(a.address))) {
          return callback(Object.assign(new Error('blocked: resolves to a private address'), { code: 'EBLOCKED' }), '', 4);
        }
        if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof addresses) => void)(null, addresses);
        callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (err: unknown) => callback(Object.assign(new Error('DNS lookup failed'), { code: 'ENOTFOUND', cause: err }), '', 4),
    );
  };
}
