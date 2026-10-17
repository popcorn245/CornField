/**
 * @module server/bind
 *
 * Where the server may listen. cornfield has no sign-in yet: forge sign-in (GitHub or Forgejo OAuth,
 * admins only, enforced on the server) is v1 work (docs/specs/0001-v1.md). Until it lands, the server
 * shows everything it serves to anyone who can reach it, so it only listens on this machine's loopback
 * address and refuses anything else. There is no switch to turn this off.
 */

/** The hosts the server may bind to before sign-in exists */
export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/**
 * Throws unless `host` is a loopback address.
 * @param {string} host
 */
export function assertLocalBind(host) {
  if (LOOPBACK_HOSTS.includes(String(host))) return;
  throw new Error(
    `cornfield will not listen on ${JSON.stringify(host)}: it has no sign-in yet, so it only binds to this machine `
    + `(${LOOPBACK_HOSTS.join(', ')}). Forge sign-in arrives in v1; until then, reach it over SSH port forwarding `
    + 'or run it on the machine you browse from.',
  );
}
