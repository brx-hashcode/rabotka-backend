import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

/** IPv4 ranges a server-side request must never be steered into. */
const PRIVATE_V4: Array<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 — "this network"
  [0x0a000000, 8], // 10/8
  [0x64400000, 10], // 100.64/10 — carrier-grade NAT
  [0x7f000000, 8], // 127/8 — loopback
  [0xa9fe0000, 16], // 169.254/16 — link-local, cloud metadata
  [0xac100000, 12], // 172.16/12
  [0xc0a80000, 16], // 192.168/16
  [0xc6120000, 15], // 198.18/15 — benchmarking
  [0xe0000000, 3], // 224/3 — multicast and reserved
];

function v4ToInt(ip: string): number {
  return (
    ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
  );
}

/**
 * True for loopback, private, link-local, CGNAT, multicast or reserved
 * addresses — anything that lands inside a network rather than on the public
 * internet. Unknown input counts as private: refusing is the safe answer.
 */
export function isPrivateAddress(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(ip);
  if (family === 4) {
    const n = v4ToInt(ip);
    return PRIVATE_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) >>> 0 === base;
    });
  }
  if (family === 6) {
    if (ip === '::' || ip === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
    if (mapped) return isPrivateAddress(mapped[1]);
    // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
    return /^(f[cd]|fe[89ab]|ff)/.test(ip);
  }
  return true;
}

type Lookup = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: Lookup = (hostname) =>
  dns.lookup(hostname, { all: true, verbatim: true });

/**
 * Whether any address `hostname` resolves to is private. Checked right before
 * a request, not only when the URL is saved: a public name can be re-pointed
 * at an internal address later (DNS rebinding). Unresolvable counts as
 * private.
 */
export async function resolvesToPrivateAddress(
  hostname: string,
  lookup: Lookup = defaultLookup,
): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return isPrivateAddress(host);
  try {
    const addresses = await lookup(host);
    return (
      addresses.length === 0 ||
      addresses.some((a) => isPrivateAddress(a.address))
    );
  } catch {
    return true;
  }
}
