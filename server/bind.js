/**
 * @module server/bind
 *
 * Where the server may listen (spec 0001 section 3, ADR 0004). Without sign-in it shows everything it serves to
 * anyone who can reach it, so it only listens on this machine's loopback address. With sign-in configured (the
 * forge's OAuth pair and a session secret in env, server/auth.js) **and** an https public URL, every route is behind
 * the admins-only guard and it may listen on any address: the reverse proxy in front of it ends TLS. Anything else
 * is refused at startup; there is no switch to turn this off.
 *
 * Where it listens is not enough: a web page can point its own hostname at this machine (DNS rebinding) and read
 * what a loopback server answers from the user's browser. So the `Host` of every request is checked too (`hostAllowed`).
 */

/** The hosts the server may always bind to */
export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/**
 * Throws, in words, unless the server may listen on `host`.
 * @param {string} host
 * @param {{ signIn?: boolean, publicUrl?: string | URL | null }} [opts] whether sign-in is configured, and the public URL
 */
export function assertBind(host, { signIn = false, publicUrl = null } = {}) {
  if (LOOPBACK_HOSTS.includes(String(host))) return;
  if (!signIn) {
    throw new Error(
      `cornfield will not listen on ${JSON.stringify(host)}: sign-in is not configured, so it only binds to this machine `
      + `(${LOOPBACK_HOSTS.join(', ')}). Configure forge sign-in with an https public URL (docs/sign-in.md), or reach it `
      + 'over SSH port forwarding.',
    );
  }
  let protocol = null;
  try { protocol = publicUrl ? new URL(String(publicUrl)).protocol : null; } catch { protocol = null; }
  if (protocol !== 'https:') {
    throw new Error(
      `cornfield will not listen on ${JSON.stringify(host)}: its public URL is ${publicUrl ? JSON.stringify(String(publicUrl)) : 'not set'}, `
      + 'not https, so a session cookie could cross the network in the clear. Set CORNFIELD_PUBLIC_URL to the https URL '
      + `people open, or listen on ${LOOPBACK_HOSTS.join(', ')}.`,
    );
  }
}


/** The names a request may carry in `Host` for loopback: `localhost`, `127.0.0.1` and `[::1]` (an IPv6 literal keeps its brackets) */
const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Whether a request's `Host` header names this server: a loopback name, or the host of the public URL when sign-in is
 * on. Case does not matter and a port is ignored (the attacker's page has no say over the port that matters, the
 * name is the point); a missing `Host`, an empty one, a list, or userinfo and paths in it is no match. `X-Forwarded-Host`
 * is never read: a reverse proxy sets `Host` itself, and anything else could be set by the client.
 * @param {string | undefined} header the request's `Host` header
 * @param {string | null} [publicHost] the host of the configured public URL, when sign-in is on (else null)
 * @returns {boolean}
 */
export function hostAllowed(header, publicHost = null) {
  const m = typeof header === 'string' ? /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(header) : null;
  if (!m || (m[2] !== undefined && Number(m[2]) > 65535)) return false;
  const name = m[1].toLowerCase();
  return LOOPBACK_NAMES.includes(name) || (publicHost !== null && name === String(publicHost).toLowerCase());
}
