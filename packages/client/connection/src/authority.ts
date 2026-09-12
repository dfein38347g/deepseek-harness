/**
 * WHATWG authority normalization shared by the /api request fence (Host half)
 * and the browser page's own privileged-surface classification (Client half).
 * Both halves compare against the same `trustedHosts` strings, so both must
 * parse and match through this one implementation; the page-side mirror
 * cannot diverge from the fence by construction.
 */

/**
 * Normalized URL of an authority string (hostname lowercased, default port
 * stripped, IPv6 bracketed), or undefined when unparsable. Shared by the
 * request fence and the page-authority classification so both sides normalize
 * identically.
 * @param authority - a Host-header value or a page authority (`hostname` plus any non-default port).
 */
export function parseAuthority(authority: string): URL | undefined {
  try {
    // http: is a WHATWG "special scheme": parsing yields a non-empty hostname or throws.
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/**
 * Canonical form of a parsed authority: `hostname` when no port was written,
 * else `hostname:port`. The port is judged from URL parses under both special
 * schemes (their default ports differ, so `:80` and `:443` still count as
 * explicit), never from the raw string, where WHATWG trimming would misread
 * shapes like `host:port ` as port-less.
 */
export function canonicalAuthority(entry: string, entryUrl: URL): string {
  // An authority that parsed under http cannot fail under https.
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/**
 * Whether an authority matches a `trustedHosts` entry. An entry with an
 * explicit port matches that exact authority; a port-less entry matches the
 * hostname on any port (the shape the CLI derives for IP-literal LAN serving,
 * where the bound port may be OS-assigned). Both sides compare through WHATWG
 * normalization, so case and a redundant `:80` never decide trust. The
 * /api request fence and the browser page's own privileged-surface
 * classification share this matcher, so the two can never diverge: a page
 * served from a declared authority is trusted by the page exactly when its
 * own requests are trusted by the fence.
 * @param hostUrl - the normalized request or page authority.
 * @param trustedHosts - the deployment's declared non-loopback authorities.
 */
export function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}
