// Request blocking (contract section 5), in two layers:
//  1. `isBlockedUrl` on every request the browser context lets us intercept (pages, frames, popups,
//     subresources, WebSockets). Hostnames are normalized by the WHATWG URL parser first, which turns IPv4
//     shorthand (decimal, hex, octal: `2852039166`, `0xa9fea9fe`) into dotted form and compresses IPv6.
//  2. `hostResolverRules` in Chromium's own resolver, for what interception never sees: redirect targets,
//     worker traffic. Chromium canonicalizes IP literals the same way before the rules apply.
// LIMIT: both layers look at the *name or literal in the URL*. A public name that resolves to a private or
// metadata address (DNS rebinding, or simply a hostile DNS record) is not caught. This is not full SSRF
// protection; isolate the worker's network (egress firewall) where that matters.

/** Cloud metadata endpoints by name. */
const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata.goog", "metadata.azure.internal"]);

/** IPv6 metadata addresses, in compressed form. */
const METADATA_IPV6 = new Set(["fd00:ec2::254"]);

/** Always blocked: link-local (169.254.0.0/16 holds the AWS/GCP/Azure/ECS metadata services) and Alibaba's. */
const ALWAYS_BLOCKED_V4: [number, number][] = [
  [ipv4("169.254.0.0"), 16],
  [ipv4("100.100.100.200"), 32],
];

/** Blocked when `blockPrivateNetworks` is on. */
const PRIVATE_V4: [number, number][] = [
  [ipv4("0.0.0.0"), 8],
  [ipv4("10.0.0.0"), 8],
  [ipv4("100.64.0.0"), 10],
  [ipv4("127.0.0.0"), 8],
  [ipv4("172.16.0.0"), 12],
  [ipv4("192.168.0.0"), 16],
];

function ipv4(dotted: string): number {
  return dotted.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

function inRange(ip: number, [base, bits]: [number, number]): boolean {
  const size = 2 ** (32 - bits);
  return Math.floor(ip / size) === Math.floor(base / size);
}

/** Dotted IPv4, or the IPv4 inside an IPv4-mapped IPv6 address (`::ffff:a9fe:a9fe`). */
function asIpv4(host: string): number | undefined {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return ipv4(host);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) return parseInt(mapped[1]!, 16) * 65536 + parseInt(mapped[2]!, 16);
  const mappedDotted = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/.exec(host);
  return mappedDotted ? ipv4(mappedDotted[1]!) : undefined;
}

export interface NetworkRules {
  blockPrivateNetworks: boolean;
}

/**
 * Host patterns (Chromium `MatchPattern`: `*` any run, `?` one character) for the always-blocked addresses.
 * IPv6 is written without brackets and as Chromium prints it (IPv4-mapped in hex: `::ffff:a9fe:a9fe`).
 * IPv6 patterns all contain `:`, so they never match a hostname.
 */
const ALWAYS_BLOCKED_PATTERNS = [
  "169.254.*",
  "100.100.100.200",
  "::ffff:a9fe:*",
  "::ffff:6464:64c8",
  "fe8?:*",
  "fe9?:*",
  "fea?:*",
  "feb?:*",
  ...METADATA_IPV6,
  ...METADATA_HOSTS,
];

/** `PRIVATE_V4` and the private IPv6 ranges as patterns, also in IPv4-mapped form. */
const PRIVATE_PATTERNS = [
  "0.*",
  "10.*",
  "127.*",
  "192.168.*",
  ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.*`),
  ...Array.from({ length: 64 }, (_, i) => `100.${64 + i}.*`),
  "localhost",
  "*.localhost",
  "::1",
  "::",
  "fc*:*",
  "fd*:*",
  "::ffff:?:*", // 0.0.0.0/8 (0000–00ff, printed without leading zeros)
  "::ffff:??:*",
  "::ffff:a??:*", // 10/8 (0a00–0aff)
  "::ffff:7f??:*", // 127/8
  "::ffff:c0a8:*", // 192.168/16
  "::ffff:ac1?:*", // 172.16/12
  "::ffff:644?:*", // 100.64/10
  "::ffff:645?:*",
  "::ffff:646?:*",
  "::ffff:647?:*",
];

/**
 * Chromium `--host-resolver-rules` refusing the blocked hosts, in the same normalized set `isBlockedUrl` checks. Request interception never sees redirect
 * targets (nor some worker traffic), so the browser's own resolver refuses them too. `allow` maps names to
 * addresses ahead of the blocking rules (tests reach the loopback fixture server under a name this way).
 */
export function hostResolverRules(rules: NetworkRules, allow: Record<string, string> = {}): string {
  const patterns = [...ALWAYS_BLOCKED_PATTERNS, ...(rules.blockPrivateNetworks ? PRIVATE_PATTERNS : [])];
  // `isBlockedUrl` drops a trailing dot (`localhost.` is `localhost`); Chromium's rules match the name as
  // written, so every non-IPv6 pattern is listed with the dot too. IPv6 patterns never end in a dot.
  const blocked = patterns.flatMap((p) => (p.includes(":") ? [p] : [p, `${p}.`]));
  return [...Object.entries(allow).map(([host, ip]) => `MAP ${host} ${ip}`), ...blocked.map((host) => `MAP ${host} ~NOTFOUND`)].join(", ");
}

/** True when the runner must not let the browser request `url`. Only http(s) and ws(s) are allowed at all. */
export function isBlockedUrl(url: string, rules: NetworkRules): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return true;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (METADATA_HOSTS.has(host) || METADATA_IPV6.has(host)) return true;
  const v4 = asIpv4(host);
  if (v4 !== undefined) {
    if (ALWAYS_BLOCKED_V4.some((r) => inRange(v4, r))) return true;
    return rules.blockPrivateNetworks && PRIVATE_V4.some((r) => inRange(v4, r));
  }
  if (host.includes(":")) {
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // link-local
    if (rules.blockPrivateNetworks && (host === "::1" || host === "::" || /^f[cd][0-9a-f]{2}:/.test(host))) return true;
    return false;
  }
  return rules.blockPrivateNetworks && (host === "localhost" || host.endsWith(".localhost"));
}
