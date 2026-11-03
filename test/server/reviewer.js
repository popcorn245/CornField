/**
 * Who is signed in, as the review button's route is told in a test (server/proposals.js `SignedIn`): maintainer-one of
 * the recorded GitHub answers (id 1001), the repo they maintain, where their audit rows go, and a clock that moves ten
 * seconds with every look, so the flood and repeat limits (server/throttle.js) never trip unless a test stops it.
 */
export function reviewerOf(record = () => {}, overrides = {}) {
  let t = Date.parse('2026-10-18T13:00:00Z');
  return { login: 'maintainer-one', userId: '1001', repo: 'owner/name', record, limits: { auth: {}, now: () => (t += 10_000) }, ...overrides };
}
