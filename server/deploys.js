/**
 * @module server/deploys
 *
 * Which workflow runs are deploys, and what each one restarted (PIPE-03, docs/deploys.md). Pure: no I/O. The runs come
 * from the forge (`forge.runs()`, server/forge.js); the rest is the config's `deploys`:
 *
 *   deploys: {
 *     workflows: ['*deploy*'],                                  // which workflows are deploys
 *     restarts: { 'Deploy web': ['stack-web'], 'deploy-*.yml': ['machine-nas'] },   // what a deploy restarts
 *   }
 *
 * A pattern is plain text with `*` for "anything", compared with the run's workflow name ("Deploy web") and its file
 * name ("deploy.yml") alike, whatever the case. `restarts` values are map nodes: an id ("stack-web") or a label
 * ("web"); a stack also restarts its containers (the explorer works that out from the map). A deploy that no
 * `restarts` pattern names is still listed, with `restarts: []`: unmapped, never dropped.
 */

/** The patterns used when the config names none: any workflow with "deploy" in its name */
export const DEFAULT_WORKFLOWS = Object.freeze(['*deploy*']);

/** Whether a name fits a pattern: `*` is any run of characters, everything else is itself; case does not matter */
export function fits(pattern, name) {
  const re = new RegExp(`^${String(pattern).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return re.test(String(name));
}

const names = (run) => [run.name, run.workflow].filter((n) => typeof n === 'string' && n !== '');
const anyFits = (pattern, run) => names(run).some((n) => fits(pattern, n));

/**
 * The runs that are deploys, each with the nodes the config says it restarted.
 * @param {import('./forge.js').Run[]} runs newest first
 * @param {{ workflows?: string[], restarts?: Record<string, string[]> } | null | undefined} deploys the config's `deploys`
 * @returns {(import('./forge.js').Run & { restarts: string[] })[]} in the same order; `restarts` is [] when unmapped
 */
export function deploysOf(runs, deploys) {
  const workflows = deploys && Array.isArray(deploys.workflows) ? deploys.workflows : DEFAULT_WORKFLOWS;
  const restarts = Object.entries((deploys && deploys.restarts) || {});
  return runs
    .filter((run) => workflows.some((w) => anyFits(w, run)))
    .map((run) => ({ ...run, restarts: [...new Set(restarts.filter(([pattern]) => anyFits(pattern, run)).flatMap(([, refs]) => refs))] }));
}
