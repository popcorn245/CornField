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
 * on another origin (a host app, docs/embedding.md) the request is credentialed, which the server answers for a listed origin.
 */
export function credentialed(inst) {
  return (path, init) => inst.fetch(path, inst.base ? { credentials: 'include', ...init } : init);
}
