/**
 * @module explorer/engine/connection
 *
 * The words for a failure that has no answer from the server, for an instance (spec 0011 D2): offline, it is "You are offline", not "cornfield
 * could not be reached", and an action says it was not sent and keeps what the person typed. The banner that says it when the browser goes
 * offline or comes back is the page's (explorer/connection.js); a piece only needs the words.
 */

/** The words for an action that got no answer: offline, it was not sent (and what was typed is still there); online, the server did not answer */
export function notSentWords(inst, what) {
  return inst.offline() ? `You are offline. ${what} was not sent; what you typed is kept. Try again when you are back.` : `cornfield did not answer. ${what} was not sent; what you typed is kept.`;
}

/**
 * `fetch` for a read or a write that carries the maintainer's session: on the instance's own origin it is exactly `inst.fetch`; against a base
 * on another origin (a host app, docs/embedding.md) the request is credentialed, which the server answers for a listed origin. A URL on another
 * origin than the base's (an absolute URL, a `//host` path) is fetched without credentials.
 */
export function credentialed(inst) {
  return (path, init) => inst.fetch(path, inst.base && underBase(inst, path) ? { credentials: 'include', ...init } : init);
}

/** Whether `path`, made absolute against the instance's base (as `inst.fetch` makes it), is on the base's origin: only those carry the maintainer's session */
function underBase(inst, path) {
  try { return new URL(inst.url(String(path)), inst.base).origin === new URL(inst.base).origin; } catch { return false; }
}
