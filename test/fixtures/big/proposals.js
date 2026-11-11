/**
 * Proposals for any map: about 70 files for docs/specs/proposals/ (docs/proposals.md), whose ids are picked from the topology
 * they are made for, so the same code serves the synthetic big map and any other topology folder (`make.js --from <dir>`).
 *
 *   0001-0064   small ones: a page, a service, a table, a change, a removal, an edge, an outside service (one to three scenarios)
 *   0100-0105   six rich ones: adds, changes and removes, 3 or more scenarios, walks that cross far-apart parts of the map;
 *               0100 also carries a mockup (an SVG beside the file)
 *
 * Nothing here names anything: every word of a title comes from the picked nodes. Deterministic for a seed.
 */

/** A seeded generator (mulberry32): the same numbers for the same seed; make.js uses it too */
export const rng = (seed) => {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  return { next, int, pick: (l) => l[int(l.length)], chance: (p) => next() < p, shuffle: (l) => { const o = [...l]; for (let i = o.length - 1; i > 0; i--) { const j = int(i + 1); [o[i], o[j]] = [o[j], o[i]]; } return o; } };
};

export const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
export const kebab = (s) => String(s).replace(/_/g, '-');
const words = (s) => kebab(s).replace(/[^A-Za-z0-9]+/g, ' ').trim();
const slugOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
const clip = (s, n) => String(s).slice(0, n).replace(/-$/, '');

const SUFFIXES = ['timeline', 'history', 'notes', 'export-csv', 'duplicate', 'archive', 'restore', 'audit', 'share', 'preview', 'summary', 'activity', 'compare', 'print', 'tags'];
const VERBS = ['Add', 'Show', 'Let people', 'Make', 'Speed up', 'Simplify'];
const ACTIONS = ['add', 'update', 'archive', 'flag', 'approve', 'merge'];
const PRE = ['nightly', 'hourly', 'stale', 'bulk', 'retry', 'weekly'];
const POST = ['cleanup', 'rollup', 'sync', 'digest', 'audit', 'refresh'];
const NEW_EXTERNALS = ['Identity provider', 'Workflow automation', 'Product analytics', 'Edge cache', 'Feature flag service', 'Headless CMS', 'Bank feed provider', 'Fraud scoring', 'Translation service', 'Video transcoder'];

/**
 * @param {{ nodes: any[], edges: any[] }} topo
 * @param {{ seed?: number }} [opts]
 * @returns {Record<string, string>} file name (relative to the proposals folder) -> text
 */
export function makeProposals(topo, { seed = 245 } = {}) {
  const R = rng(seed + 7);
  const nodes = new Map(topo.nodes.map((n) => [n.id, n]));
  const edges = topo.edges;
  const own = edges.filter((e) => !e.kind && !e.dashed);
  const parentOf = new Map();
  own.forEach((e) => { if (!parentOf.has(e.to)) parentOf.set(e.to, e.from); });
  const kids = (id) => own.filter((e) => e.from === id).map((e) => nodes.get(e.to)).filter(Boolean);
  const ofType = (t) => topo.nodes.filter((n) => n.type === t);
  const apps = ofType('app');
  const appOf = (id) => { for (let cur = id, k = 0; cur && k < 6; cur = parentOf.get(cur), k++) if (nodes.get(cur)?.type === 'app') return cur; return null; };
  const pagesOf = (appId) => kids(appId).filter((n) => n.type === 'page');
  const tablesAll = ofType('table').filter((t) => t.table);
  const servicesAll = ofType('service');
  const cloud = topo.nodes.filter((n) => n.type === 'external' && n.kind === 'cloud');
  const cloudParent = cloud.length ? parentOf.get(cloud[0].id) : null;
  const rootId = ofType('root')[0]?.id;
  const stores = ofType('store');
  const queueStore = edges.find((e) => e.kind === 'triggers' && nodes.get(e.from)?.type === 'store')?.from || stores[0]?.id;
  const personas = ofType('persona');
  /** The i-th persona's id as a scenario names it (`persona-shopper` -> `shopper`), or nothing when the map has fewer */
  const who = (i) => (personas[i] ? { actor: personas[i].id.replace(/^persona-/, '') } : {});
  const edgeKey = (e) => `${e.from}|${e.to}|${e.kind || ''}|${e.flow || ''}`;
  const ref = (e) => ({ from: e.from, to: e.to, ...(e.kind ? { kind: e.kind } : {}), ...(e.flow ? { flow: e.flow } : {}) });
  const readsOf = (id) => edges.find((e) => e.kind === 'reads' && e.to === id);
  const writesOf = (id) => edges.filter((e) => e.kind === 'writes' && e.from === id);
  const servicesOfApp = (appId) => kids(appId).filter((n) => n.type === 'service');
  const tablesOfApp = (appId) => kids(appId).filter((n) => n.type === 'table');
  const appsWith = (f) => apps.filter((a) => f(a.id).length > 0);
  const frontApps = appsWith(pagesOf).filter((a) => pagesOf(a.id).some((p) => readsOf(p.id)));
  const svcApps = appsWith(servicesOfApp);
  const tableApps = [...new Set(tablesAll.map((t) => parentOf.get(t.id)))].map((id) => nodes.get(id)).filter(Boolean);
  const svcKinds = [...new Set(servicesAll.map((s) => s.kind).filter(Boolean))];
  const files = {};
  const used = new Set();
  const fresh = (id) => { let out = id; for (let k = 2; used.has(out) || nodes.has(out); k++) out = `${id}-${k}`; used.add(out); return out; };
  const claimed = new Set();
  const put = (num, slug, body) => {
    const name = `${String(num).padStart(4, '0')}-${clip(slug, 60)}`;
    files[`${name}.json`] = json({ version: 1, spec: String(num).padStart(4, '0'), ...body });
    return name;
  };

  // an undirected walk over the map, for the scenarios that cross it
  const adj = new Map();
  edges.forEach((e) => {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from).push({ to: e.to, e });
    adj.get(e.to).push({ to: e.from, e });
  });
  /** The longest shortest path (up to `max` hops) from `start`, as edges; the walk of a scenario */
  const farWalk = (start, max = 7) => {
    const prev = new Map([[start, null]]);
    let frontier = [start];
    let last = start;
    for (let d = 0; d < max && frontier.length; d++) {
      const next = [];
      for (const id of frontier) for (const { to, e } of adj.get(id) || []) if (!prev.has(to)) { prev.set(to, { id, e }); next.push(to); }
      if (next.length) last = next[next.length - 1];
      frontier = next;
    }
    const path = [];
    for (let cur = last; prev.get(cur); cur = prev.get(cur).id) path.unshift({ at: cur, edge: prev.get(cur).e, from: prev.get(cur).id });
    return { start, path };
  };
  const walkSteps = (w, say) => {
    const steps = [{ node: w.start, text: say(w.start, 'start') }];
    for (const hop of w.path) {
      steps.push({ edge: ref(hop.edge), text: `${nodes.get(hop.edge.from)?.label || hop.edge.from} reaches ${nodes.get(hop.edge.to)?.label || hop.edge.to}${hop.edge.label ? `: ${hop.edge.label}` : ''}.` });
      steps.push({ node: hop.at, text: say(hop.at, 'hop') });
    }
    return steps.slice(0, 13);
  };
  const sayNode = (id, mode) => `${mode === 'start' ? 'It starts at' : 'Then'} ${nodes.get(id)?.label || id}.`;
  const farApart = () => {
    // from a page in one app to whatever is farthest, so the walk crosses clusters
    const start = R.pick(frontApps.length ? pagesOf(R.pick(frontApps).id) : topo.nodes).id;
    return farWalk(start, 8);
  };

  // ---- small proposals ------------------------------------------------------------------------------------------
  const kinds = [...Array(20).fill('page'), ...Array(10).fill('service'), ...Array(8).fill('table'), ...Array(8).fill('change'), ...Array(8).fill('remove'), ...Array(6).fill('edge'), ...Array(4).fill('cloud')];
  const order = R.shuffle(kinds);

  order.forEach((kind, i) => {
    const num = i + 1;
    if (kind === 'page') {
      const app = R.pick(frontApps);
      const t = tablesAll.length ? R.pick(readsOfApp(app)) : null;
      const suffix = R.pick(SUFFIXES);
      const label = `/${kebab(t.table)}/:id/${suffix}`;
      const id = fresh(`page-${slugOf(app.id)}-${slugOf(label)}`);
      const writes = R.chance(0.4);
      const add = [{ from: t.id, to: id, kind: 'reads', status: 'proposed', keys: [`${t.table}/:id`], label: `renders ${words(t.table)} rows` }];
      if (writes) add.push({ from: id, to: t.id, kind: 'writes', status: 'proposed', label: `${t.table}.${R.pick(ACTIONS)}` });
      const steps = [{ node: id, text: `You open ${label} from the ${words(t.table)} list.` }, { edge: { from: t.id, to: id, kind: 'reads' }, text: `The page reads the ${words(t.table)} row.` }];
      if (writes) steps.push({ edge: { from: id, to: t.id, kind: 'writes' }, text: 'Saving writes the change back.' });
      put(num, `${suffix}-${t.table}-${slugOf(app.id)}`, {
        title: `${R.pick(VERBS)} ${words(suffix)} to ${words(t.table)}`, summary: `A ${words(suffix)} view of one ${words(t.table)} row in ${app.label}${writes ? ', with a save' : ''}.`,
        nodes: { add: [{ id, label, type: 'page', parent: app.id, desc: `The ${words(suffix)} of one ${words(t.table)} row.` }] },
        edges: { add }, scenarios: [{ id: 'open-it', title: `Open the ${words(suffix)}`, steps }],
      });
    } else if (kind === 'service') {
      const app = R.pick(svcApps.length ? svcApps : apps);
      const svcKind = R.pick(svcKinds.length ? svcKinds : ['job']);
      const name = `${R.pick(PRE)}-${R.pick(POST)}`;
      const id = fresh(`svc-${svcKind}-${name}`);
      const t = R.pick(tablesAll);
      const ext = R.pick(cloud);
      const add = [{ from: t.id, to: id, kind: 'reads', status: 'proposed', keys: [`${t.table}/*`], label: 'reads what it works on' }];
      if (ext) add.push({ from: id, to: ext.id, kind: 'calls', status: 'proposed', label: 'reports the result' });
      if (queueStore) add.push({ from: queueStore, to: id, kind: 'triggers', status: 'proposed', label: 'a message is queued' });
      put(num, `${name}-${svcKind}`, {
        title: `A ${name} ${svcKind}`, summary: `${app.label} gets a ${svcKind} that works on ${words(t.table)}${ext ? ` and reports to ${ext.label}` : ''}.`,
        nodes: { add: [{ id, label: name, type: 'service', kind: svcKind, parent: app.id, desc: `A ${svcKind} for ${words(t.table)}.` }] },
        edges: { add },
        scenarios: [{ id: 'it-runs', title: 'It runs', steps: [...(queueStore ? [{ edge: { from: queueStore, to: id, kind: 'triggers' }, text: 'A message wakes it.' }] : [{ node: id, text: 'It starts.' }]), { edge: { from: t.id, to: id, kind: 'reads' }, text: `It reads the ${words(t.table)} rows.` }, ...(ext ? [{ edge: { from: id, to: ext.id, kind: 'calls' }, text: `It tells ${ext.label}.` }] : [])] }],
      });
    } else if (kind === 'table') {
      const app = R.pick(tableApps.length ? tableApps : apps);
      const base = R.pick(tablesOfApp(app.id));
      const tname = `${base.table}_${R.pick(['snapshots', 'revisions', 'notes', 'flags', 'imports'])}`;
      const tid = fresh(`table-${kebab(tname)}`);
      const writer = R.pick(topo.nodes.filter((n) => (n.type === 'page' || n.type === 'service') && writesOf(n.id).length));
      put(num, kebab(tname), {
        title: `Keep ${words(tname)}`, summary: `A ${words(tname)} table in ${app.label}, written by ${writer.label}.`,
        nodes: { add: [{ id: tid, label: tname, type: 'table', table: tname, parent: app.id, desc: `The ${words(tname)} table.` }], change: [{ id: writer.id, set: { desc: `${writer.desc || writer.label} It also keeps ${words(tname)}.` }, why: 'it now writes the new table' }] },
        edges: { add: [{ from: writer.id, to: tid, kind: 'writes', status: 'proposed', label: `${tname}.add` }] },
        scenarios: [{ id: 'it-is-written', title: 'A row is kept', steps: [{ node: writer.id, text: `${writer.label} runs.` }, { edge: { from: writer.id, to: tid, kind: 'writes' }, text: 'The row is added.' }] }],
      });
    } else if (kind === 'change') {
      const picks = [R.pick(frontApps), R.pick(svcApps.length ? svcApps : apps)].map((a) => R.pick(kids(a.id).filter((n) => n.type === 'page' || n.type === 'service')));
      const uniq = [...new Map(picks.map((p) => [p.id, p])).values()];
      const t = R.pick(tablesAll);
      put(num, `reword-${slugOf(uniq[0].label)}`, {
        title: `Say what ${uniq[0].label} is for`, summary: 'Descriptions that tell a new reader what each does and where its data comes from.',
        nodes: { change: [...uniq.map((p) => ({ id: p.id, set: { desc: `${p.label}: works with ${words(t.table)} and says so up front.` }, why: 'the old description said nothing a reader could use' })), ...(uniq.some((p) => p.id === t.id) ? [] : [{ id: t.id, set: { desc: `The ${words(t.table)} table: the one place this is stored.` }, why: 'say where it lives' }])] },
        scenarios: [{ id: 'read-it', title: 'A new reader finds it', steps: [{ node: uniq[0].id, text: 'They open the node and read what it is for.' }, { node: t.id, text: 'They follow it to the table.' }] }],
      });
    } else if (kind === 'remove') {
      const cands = frontApps.flatMap((a) => pagesOf(a.id)).filter((p) => readsOf(p.id) && !claimed.has(p.id));
      const p = R.pick(cands);
      claimed.add(p.id);
      const read = readsOf(p.id);
      put(num, `retire-${slugOf(p.label)}-${num}`, {
        title: `Retire ${p.label}`, summary: `${nodes.get(appOf(p.id))?.label || 'The app'} stops serving ${p.label}; nothing links to it any more.`,
        nodes: { remove: [{ id: p.id, why: 'no traffic in 90 days, and a newer page does the same' }] },
        edges: { remove: [{ ...ref(read), why: 'the page that read it is gone' }] },
        scenarios: [{ id: 'old-path', title: 'The old path goes away', steps: [{ node: p.id, text: `A visitor used to open ${p.label}.` }, { edge: ref(read), text: 'It read its rows from here. This line goes away with the page.' }] }],
      });
    } else if (kind === 'edge') {
      const s = R.pick(servicesAll);
      const ext = R.pick(cloud.filter((c) => !edges.some((e) => e.from === s.id && e.to === c.id)));
      put(num, `${slugOf(s.label)}-uses-${slugOf(ext.label)}`, {
        title: `${s.label} calls ${ext.label}`, summary: `${s.label} starts using ${ext.label}, which is then in its blast radius.`,
        edges: { add: [{ from: s.id, to: ext.id, kind: 'calls', status: 'proposed', label: 'sends the request', when: 'run' }] },
        scenarios: [{ id: 'new-call', title: 'The new call', steps: [{ node: s.id, text: `${s.label} runs.` }, { edge: { from: s.id, to: ext.id, kind: 'calls' }, text: `It now calls ${ext.label}.` }] }, { id: 'outage', title: `${ext.label} is down`, down: [ext.id], steps: [{ node: ext.id, text: `${ext.label} stops answering.` }, { node: s.id, text: 'The service retries and then gives up for the night.' }] }],
      });
    } else {
      const label = NEW_EXTERNALS[i % NEW_EXTERNALS.length];
      const id = fresh(`ext-${slugOf(label)}`);
      const s = R.pick(servicesAll);
      put(num, `connect-${slugOf(label)}`, {
        title: `Connect ${label}`, summary: `${s.label} starts talking to ${label}, a new outside service.`,
        nodes: { add: [{ id, label, type: 'external', kind: 'cloud', ...(cloudParent ? { parent: cloudParent } : {}), roles: ['runtime'], breaks: `Now: ${s.label} cannot finish its run.`, plan: { tier: 'free' }, desc: `${label}, used by ${s.label}.` }] },
        edges: { add: [{ from: s.id, to: id, kind: 'calls', status: 'proposed', label: 'sends the request', when: 'run' }] },
        scenarios: [{ id: 'it-works', title: 'It works', steps: [{ node: s.id, text: `${s.label} runs.` }, { edge: { from: s.id, to: id, kind: 'calls' }, text: `It calls ${label}.` }] }, { id: 'it-is-down', title: `${label} is down`, down: [id], steps: [{ node: id, text: `${label} stops answering.` }, { node: s.id, text: 'The run fails and is retried later.' }] }],
      });
    }
  });
  function readsOfApp(app) {
    const own = tablesAll.filter((t) => edges.some((e) => e.kind === 'reads' && e.from === t.id && appOf(e.to) === app.id));
    return own.length ? own : tablesAll;
  }

  // ---- six rich proposals ---------------------------------------------------------------------------------------
  const rich = (num, slug, build) => put(num, slug, build());
  const pickApp = (n) => frontApps[(n * 7 + R.int(3)) % frontApps.length];
  const someTable = () => R.pick(tablesAll);
  const someExt = () => R.pick(cloud);

  // 0100: a new page, API endpoint, table and service, with a mockup; a walk across the map
  rich(100, 'new-flow-across-apps', () => {
    const a = pickApp(0); const b = R.pick(svcApps.length ? svcApps : apps);
    const t = someTable(); const ext = someExt(); const old = R.pick(pagesOf(a.id).filter((p) => readsOf(p.id)));
    const oldRead = readsOf(old.id); const oldWrites = writesOf(old.id);
    const changeTargets = R.shuffle(frontApps.flatMap((x) => pagesOf(x.id))).slice(0, 2);
    const hook = R.pick(servicesAll);
    const w = farApart();
    const pa = fresh(`page-${slugOf(a.id)}-flow`); const pb = fresh(`page-${slugOf(b.id)}-flow-api`); const tn = fresh('table-flow-items'); const sv = fresh('svc-dispatch-flow-notifier');
    return {
      title: `A new flow from ${a.label} through ${b.label}`, summary: 'A new page, its API endpoint, a table and a service that tells someone, replacing an old page.',
      nodes: {
        add: [
          { id: pa, label: '/flow/start', type: 'page', parent: a.id, desc: 'The one page where the flow starts.' },
          { id: `${pa}-done`, label: '/flow/:flowId/done', type: 'page', parent: a.id, desc: 'Where the flow ends, with a summary.' },
          { id: pb, label: '/api/v1/flow-items', type: 'page', parent: b.id, methods: ['GET', 'POST'], desc: 'GET · POST: the items of a flow.' },
          { id: tn, label: 'flow_items', type: 'table', table: 'flow_items', parent: parentOf.get(t.id) || b.id, desc: 'One row per item in a flow.' },
          { id: sv, label: 'flow-notifier', type: 'service', kind: svcKinds[0] || 'job', parent: b.id, desc: 'Tells the person when a flow finishes.' },
        ],
        change: [...changeTargets.map((p) => ({ id: p.id, set: { desc: `${p.label}: now links to the new flow.` }, why: 'the new way in' })), { id: hook.id, set: { desc: `${hook.desc || hook.label} It now also starts the flow notice.` }, why: 'it feeds the new service' }],
        remove: [{ id: old.id, why: 'replaced by the new first page' }],
      },
      edges: {
        add: [
          { from: tn, to: pa, kind: 'reads', status: 'proposed', keys: ['flow_items/*'], label: 'lists the items' },
          { from: pa, to: pb, kind: 'calls', status: 'proposed', label: 'loads and adds items' },
          { from: pb, to: tn, kind: 'writes', status: 'proposed', label: 'flow_items.add' },
          { from: pb, to: sv, kind: 'calls', status: 'proposed', label: 'asks for a notice' },
          ...(ext ? [{ from: sv, to: ext.id, kind: 'calls', status: 'proposed', label: 'sends the notice', when: 'run' }] : []),
          { from: hook.id, to: sv, kind: 'calls', status: 'proposed', label: 'hands work on' },
        ],
        remove: [...(oldRead ? [{ ...ref(oldRead), why: 'the old page is gone' }] : []), ...oldWrites.map((e) => ({ ...ref(e), why: 'the old page is gone' }))],
      },
      mockups: [{ node: pa, path: '0100-new-flow-across-apps/start.svg', title: 'The first page of the flow: a list of items and a Start button' }],
      scenarios: [
        { id: 'start-a-flow', title: 'A person starts a flow', ...(personas.length ? { actor: personas[0].id.replace(/^persona-/, '') } : {}), steps: [{ node: pa, text: 'They open the first page.' }, { edge: { from: tn, to: pa, kind: 'reads' }, text: 'It lists their items.' }, { edge: { from: pa, to: pb, kind: 'calls' }, text: 'Add calls the endpoint.' }, { edge: { from: pb, to: tn, kind: 'writes' }, text: 'The item is stored.' }] },
        { id: 'notice-goes-out', title: 'The notice goes out', ...who(2), steps: [{ node: pb, text: 'The last item is added.' }, { edge: { from: pb, to: sv, kind: 'calls' }, text: 'The endpoint calls the notifier.' }, ...(ext ? [{ edge: { from: sv, to: ext.id, kind: 'calls' }, text: `${ext.label} delivers it.` }] : [])] },
        { id: 'across-the-map', title: 'A long walk across the map', ...who(0), steps: walkSteps(w, sayNode).map((st, i) => (i === 2 && personas[3] ? { ...st, ...who(3) } : st)) },
        { id: 'old-page-goes', title: 'The old page goes away', steps: [{ node: old.id, text: `${old.label} is removed.` }, ...(oldRead ? [{ edge: ref(oldRead), text: 'And the read that fed it.' }] : [])] },
        ...(ext ? [{ id: 'provider-down', title: `${ext.label} is down`, down: [ext.id], steps: [{ node: ext.id, text: 'The provider is out.' }, { node: sv, text: 'Notices queue up.' }] }] : []),
      ],
    };
  });
  files['0100-new-flow-across-apps/start.svg'] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 240" width="360" height="240" role="img" aria-labelledby="t">
  <title id="t">The first page of the flow: a list of items and a Start button</title>
  <rect width="360" height="240" fill="#f8fafc"/>
  <rect width="360" height="36" fill="#0f172a"/>
  <text x="16" y="23" font-family="sans-serif" font-size="14" fill="#f8fafc">Flow / Start</text>
  <rect x="16" y="50" width="328" height="40" fill="#fff" stroke="#cbd5e1"/>
  <text x="28" y="75" font-family="sans-serif" font-size="13" fill="#0f172a">First item</text>
  <rect x="16" y="98" width="328" height="40" fill="#fff" stroke="#cbd5e1"/>
  <text x="28" y="123" font-family="sans-serif" font-size="13" fill="#0f172a">Second item</text>
  <rect x="16" y="182" width="328" height="40" fill="#4f46e5"/>
  <text x="180" y="207" text-anchor="middle" font-family="sans-serif" font-size="15" fill="#fff">Start</text>
</svg>
`;

  // 0101: devices and alerts: a machine-side source to a person, via services and outside providers
  rich(101, 'alerts-to-people', () => {
    const dev = ofType('device')[0]; const svc = R.pick(servicesAll); const svc2 = R.pick(servicesAll.filter((s) => s.id !== svc.id));
    const ext1 = someExt(); const ext2 = R.pick(cloud.filter((c) => c.id !== ext1?.id)); const app = pickApp(1); const retire = R.pick(servicesAll.filter((s) => s.id !== svc.id && s.id !== svc2.id));
    const t = someTable(); const w = farApart();
    const hk = fresh('svc-hook-on-alert'); const tn = fresh('table-alert-rules'); const pg = fresh(`page-${slugOf(app.id)}-alert-rules`);
    const retireEdge = edges.find((e) => e.to === retire.id || e.from === retire.id);
    return {
      title: 'Alerts to people', summary: 'Something that sees a change pages the right person within seconds, and one old service is retired.',
      nodes: {
        add: [{ id: hk, label: 'on-alert', type: 'service', kind: svcKinds.includes('hook') ? 'hook' : svcKinds[0] || 'job', parent: parentOf.get(svc.id), desc: 'Runs when something worth an alert happens.' }, { id: tn, label: 'alert_rules', type: 'table', table: 'alert_rules', parent: parentOf.get(t.id), desc: 'Who is told about what, and when.' }, { id: pg, label: '/alerts/rules/:ruleId', type: 'page', parent: app.id, desc: 'Edit who is paged, and the quiet hours.' }],
        change: [{ id: svc.id, set: { desc: `${svc.desc || svc.label} A change now fires the alert hook.` }, why: 'it is the source of the new alert' }, { id: svc2.id, set: { desc: `${svc2.desc || svc2.label} Also reaches phones.` }, why: 'a new channel' }, ...(dev ? [{ id: dev.id, set: { desc: `${dev.desc || dev.label} Its events now raise alerts.` }, why: 'it is where alerts begin' }] : [])],
        remove: [{ id: retire.id, why: 'the hook replaces its polling' }],
      },
      edges: {
        add: [
          ...(queueStore ? [{ from: queueStore, to: hk, kind: 'triggers', status: 'proposed', label: 'an event was published' }] : []),
          { from: tn, to: hk, kind: 'reads', status: 'proposed', keys: ['alert_rules/*'], label: 'who to tell' },
          { from: hk, to: svc2.id, kind: 'calls', status: 'proposed', label: 'sends the notice' },
          ...(ext1 ? [{ from: svc2.id, to: ext1.id, kind: 'calls', status: 'proposed', label: 'pushes to the phone', when: 'run' }] : []),
          ...(ext2 ? [{ from: svc2.id, to: ext2.id, kind: 'calls', status: 'proposed', label: 'texts when push fails', when: 'run' }] : []),
          { from: tn, to: pg, kind: 'reads', status: 'proposed', keys: ['alert_rules/:id'], label: 'shows the rule' },
          { from: pg, to: tn, kind: 'writes', status: 'proposed', label: 'alert_rules.update' },
        ],
        remove: retireEdge ? [{ ...ref(retireEdge), why: 'the service is gone' }] : [],
      },
      scenarios: [
        { id: 'event-pages-someone', title: 'An event pages the on-call person', ...(personas.length ? { actor: personas[personas.length - 1].id.replace(/^persona-/, '') } : {}), steps: [{ node: (dev || svc).id, text: 'Something happens.' }, ...(queueStore ? [{ edge: { from: queueStore, to: hk, kind: 'triggers' }, text: 'It is published.' }] : []), { edge: { from: hk, to: svc2.id, kind: 'calls' }, text: 'The hook asks for a notice.' }, ...(ext1 ? [{ edge: { from: svc2.id, to: ext1.id, kind: 'calls' }, text: 'The push reaches the phone.' }] : [])] },
        { id: 'push-fails', title: 'Push fails, so a text goes out', steps: [...(ext1 ? [{ edge: { from: svc2.id, to: ext1.id, kind: 'calls' }, text: 'The push gateway does not answer.' }] : [{ node: svc2.id, text: 'Push fails.' }]), ...(ext2 ? [{ edge: { from: svc2.id, to: ext2.id, kind: 'calls' }, text: 'The SMS provider is tried next.' }] : [])] },
        { id: 'edit-quiet-hours', title: 'Someone sets quiet hours', steps: [{ node: pg, text: 'They open one rule.' }, { edge: { from: pg, to: tn, kind: 'writes' }, text: 'The quiet hours are saved.' }, { edge: { from: tn, to: hk, kind: 'reads' }, text: 'The next alert honours them.' }] },
        { id: 'across-the-map', title: 'From here to the far side of the map', steps: walkSteps(w, sayNode) },
        ...(ext1 ? [{ id: 'push-down', title: 'The push gateway is down', down: [ext1.id], steps: [{ node: ext1.id, text: 'The gateway is out.' }, { node: svc2.id, text: 'Every notice falls back to text.' }] }] : []),
      ],
    };
  });

  // 0102: retire several pages, a service and an outside service
  rich(102, 'retire-a-feed', () => {
    const a = pickApp(2); const rem = R.shuffle(pagesOf(a.id).filter((p) => readsOf(p.id))).slice(0, 3); const ext = someExt();
    const svc = R.pick(servicesAll); const app2 = pickApp(3); const target = R.pick(pagesOf(app2.id)); const t = someTable();
    const np = fresh(`page-${slugOf(app2.id)}-bulk-upload`); const w = farApart();
    const extEdges = ext ? edges.filter((e) => e.to === ext.id).slice(0, 2) : [];
    return {
      title: 'Retire the old import', summary: `The import that fed ${a.label} goes away; sellers upload instead.`,
      nodes: {
        add: [{ id: np, label: '/uploads/bulk', type: 'page', parent: app2.id, desc: 'Upload a spreadsheet; errors come back per row.' }],
        change: [{ id: svc.id, set: { desc: `${svc.desc || svc.label} Runs on change, not on a schedule.` }, why: 'nothing bulk-loads on a timer now' }, { id: target.id, set: { desc: `${target.label}: with a link to bulk upload.` }, why: 'the new way in' }, { id: a.id, set: { desc: `${a.label}: no longer mirrors the old feed.` }, why: 'the feed is gone' }],
        remove: [...rem.map((p) => ({ id: p.id, why: 'only the old feed used it' })), ...(ext && !extEdges.length ? [] : ext ? [{ id: ext.id, why: 'the feed is cancelled' }] : [])],
      },
      edges: {
        add: [{ from: t.id, to: np, kind: 'reads', status: 'proposed', keys: [`${t.table}/*`], label: 'shows what is already listed' }, { from: np, to: t.id, kind: 'writes', status: 'proposed', label: `${t.table}.add` }],
        remove: [...rem.map((p) => readsOf(p.id)).filter(Boolean).map((e) => ({ ...ref(e), why: 'the page is gone' })), ...extEdges.map((e) => ({ ...ref(e), why: 'the feed is cancelled' }))],
      },
      scenarios: [
        { id: 'upload', title: 'Someone uploads a spreadsheet', steps: [{ node: target.id, text: 'They open the page.' }, { node: np, text: 'They choose bulk upload.' }, { edge: { from: np, to: t.id, kind: 'writes' }, text: 'Each valid row is stored.' }] },
        { id: 'old-path', title: 'The old path goes away', steps: rem.flatMap((p) => [{ node: p.id, text: `${p.label} is removed.` }]) },
        { id: 'new-row-shows-up', title: 'A new row shows up elsewhere', steps: [{ edge: { from: np, to: t.id, kind: 'writes' }, text: 'A row is stored.' }, { node: svc.id, text: 'The service reacts to the change.' }, { node: R.pick(pagesOf(pickApp(4).id)).id, text: 'A page in another app shows it.' }] },
        { id: 'across-the-map', title: 'From the retired area to the far side', steps: walkSteps(farWalk(rem[0].id, 8), sayNode) },
      ],
    };
  });

  // 0103: add a new outside provider and swap it in for another
  rich(103, 'swap-a-provider', () => {
    const old = someExt(); const oldEdges = edges.filter((e) => e.to === old.id && e.kind === 'calls').slice(0, 3);
    const callers = oldEdges.map((e) => nodes.get(e.from));
    const id = fresh('ext-new-provider'); const tn = fresh('table-provider-lines'); const sv = fresh('svc-client-provider-feed');
    const consumer = R.pick(servicesAll); const pg = R.pick(pagesOf(pickApp(5).id)); const w = farApart();
    return {
      title: `Swap ${old.label} for a new provider`, summary: `${old.label} is replaced by a provider that also gives us a nightly feed we reconcile against.`,
      nodes: {
        add: [{ id, label: 'New provider', type: 'external', kind: 'cloud', ...(cloudParent ? { parent: cloudParent } : {}), roles: ['runtime', 'account'], breaks: 'Now: calls to it fail and the nightly feed is skipped.', plan: { tier: 'paid', note: 'billed per call' }, desc: 'The replacement provider, read and written through the feed client.' }, { id: sv, label: 'provider-feed', type: 'service', kind: svcKinds[0] || 'job', parent: parentOf.get(consumer.id), desc: 'Fetches the nightly feed.' }, { id: tn, label: 'provider_lines', type: 'table', table: 'provider_lines', parent: parentOf.get(someTable().id), desc: 'One row per feed line.' }],
        change: [{ id: consumer.id, set: { desc: `${consumer.desc || consumer.label} Now matches against the feed.` }, why: 'it has a feed to match' }, { id: pg.id, set: { desc: `${pg.label}: also lists feed lines.` }, why: 'people need to see them' }],
        remove: [{ id: old.id, why: 'replaced by the new provider' }],
      },
      edges: {
        add: [{ from: sv, to: id, kind: 'calls', status: 'proposed', label: 'fetches the feed', when: 'run' }, { from: sv, to: tn, kind: 'writes', status: 'proposed', label: 'provider_lines.add' }, { from: tn, to: consumer.id, kind: 'reads', status: 'proposed', keys: ['provider_lines/*'], label: 'the lines to match' }, { from: tn, to: pg.id, kind: 'reads', status: 'proposed', keys: ['provider_lines/unmatched'], label: 'lists the unmatched' }, ...callers.filter((c) => c.type !== 'external').map((c) => ({ from: c.id, to: id, kind: 'calls', status: 'proposed', label: 'now calls the new provider', when: 'run' }))],
        remove: oldEdges.map((e) => ({ ...ref(e), why: `${old.label} is gone` })),
      },
      scenarios: [
        { id: 'nightly-feed', title: 'The nightly feed is matched', steps: [{ node: sv, text: 'The feed client starts.' }, { edge: { from: sv, to: id, kind: 'calls' }, text: 'It fetches the feed.' }, { edge: { from: sv, to: tn, kind: 'writes' }, text: 'Lines are stored.' }, { edge: { from: tn, to: consumer.id, kind: 'reads' }, text: 'The matcher reads them.' }] },
        { id: 'someone-fixes', title: 'Someone matches one by hand', steps: [{ node: pg.id, text: 'They open the page.' }, { edge: { from: tn, to: pg.id, kind: 'reads' }, text: 'The unmatched lines are listed.' }] },
        { id: 'provider-down', title: 'The new provider is down', down: [id], steps: [{ node: id, text: 'The provider is unavailable.' }, { node: sv, text: 'The client gets nothing and says so.' }, { node: pg.id, text: 'People see last night\'s list, marked stale.' }] },
        { id: 'across-the-map', title: 'From the provider to the far side', steps: walkSteps(farWalk(consumer.id, 8), sayNode) },
      ],
    };
  });

  // 0104: a shared component that many pages use
  rich(104, 'shared-component', () => {
    const molecules = ofType('molecule'); const pkgs = ofType('pkg'); const tokens = ofType('token');
    const m = R.pick(molecules); const tk = R.pick(tokens); const pk = R.pick(pkgs);
    const users = R.shuffle(frontApps.flatMap((a) => pagesOf(a.id))).slice(0, 5);
    const mid = fresh('molecule-shared-box'); const pid = fresh('pkg-shared-box');
    const drop = R.pick(molecules.filter((x) => x.id !== m.id));
    const dropEdges = edges.filter((e) => e.to === drop.id || e.from === drop.id).slice(0, 3);
    return {
      title: `One shared ${m.label} for every app`, summary: 'A shared package holds the one component; the apps use it, and an older duplicate goes.',
      nodes: {
        add: [{ id: pid, label: '@shared/box', type: 'pkg', parent: rootId, file: 'packages/shared-box', desc: 'The shared component package.' }, { id: mid, label: 'shared-box', type: 'molecule', parent: pk ? pk.id : rootId, desc: 'The one box, built from the same atoms.' }],
        change: [{ id: m.id, set: { desc: `${m.label}: now wraps the shared box.` }, why: 'one component for every app' }, { id: tk.id, set: { desc: `${tk.label}: also drives the shared box.` }, why: 'it reads these tokens' }, { id: users[0].id, set: { desc: `${users[0].label}: uses the shared box.` }, why: 'the first user' }],
        remove: [{ id: drop.id, why: 'a duplicate of the shared box' }],
      },
      edges: {
        add: [{ from: mid, to: tk.id, kind: 'uses', status: 'proposed', vars: ['--shared-box-base'], label: 'reads the vars' }, { from: pid, to: mid, dashed: true, label: 'holds' }, ...users.map((p) => ({ from: p.id, to: mid, dashed: true, label: 'uses' }))],
        remove: dropEdges.map((e) => ({ ...ref(e), why: 'the duplicate is gone' })),
      },
      scenarios: [
        { id: 'page-uses-it', title: 'A page shows the shared box', steps: [{ node: users[0].id, text: 'A page renders.' }, { node: mid, text: 'It draws the shared box.' }, { node: tk.id, text: 'Styled by the tokens.' }] },
        { id: 'every-user', title: 'Every user gets the change', steps: users.map((p) => ({ node: p.id, text: `${p.label} picks up the change.` })) },
        { id: 'duplicate-goes', title: 'The duplicate goes away', steps: [{ node: drop.id, text: `${drop.label} is removed.` }, { node: mid, text: 'Its users move to the shared box.' }] },
        { id: 'across-the-map', title: 'From a user to the far side', steps: walkSteps(farWalk(users[1].id, 8), sayNode) },
      ],
    };
  });

  // 0105: a second site: a new machine and stack, and what moves onto it
  rich(105, 'second-site', () => {
    const stacks = ofType('stack'); const machines = ofType('machine'); const devices = ofType('device');
    const st = R.pick(stacks); const mc = R.pick(machines); const app = R.pick(apps.filter((a) => edges.some((e) => e.from === a.id && e.kind === 'runs-on')));
    const runs = edges.find((e) => e.from === app.id && e.kind === 'runs-on'); const ext = someExt();
    const dev = devices[0]; const w = farApart();
    const mid = fresh('machine-site-two'); const sid = fresh('stack-site-two'); const c1 = fresh('container-site-two-web'); const c2 = fresh('container-site-two-db'); const eid = fresh('ext-site-two-line');
    return {
      title: 'A second site', summary: `A new machine and stack run ${app.label}, so the main site can go down without taking it with it.`,
      nodes: {
        add: [{ id: mid, label: 'site-two', type: 'machine', hostname: 'site-two', file: mc.file, parent: parentOf.get(mc.id) || rootId, desc: 'The box at the second location.' }, { id: sid, label: 'site-two', type: 'stack', parent: parentOf.get(st.id) || rootId, file: st.file, services: [{ name: 'web', image: 'images.example.test/app:1', ports: [], volumes: [] }, { name: 'db', image: 'images.example.test/sql-db:16', ports: [], volumes: [] }], desc: 'Docker compose stack: web, db.' }, { id: c1, label: 'site-two-web', type: 'container', parent: sid, stack: 'site-two', service: 'web', image: 'images.example.test/app:1', file: st.file, ports: [] }, { id: c2, label: 'site-two-db', type: 'container', parent: sid, stack: 'site-two', service: 'db', image: 'images.example.test/sql-db:16', file: st.file, ports: [] }, { id: eid, label: 'Second site line', type: 'external', kind: 'cloud', ...(cloudParent ? { parent: cloudParent } : {}), roles: ['runtime', 'account'], breaks: 'Now: the second site is offline; the main site is unaffected.', plan: { tier: 'paid' }, desc: 'The internet line at the second location.' }],
        change: [{ id: app.id, set: { desc: `${app.label}: now served from both sites.` }, why: 'it moves to the new stack too' }, { id: mc.id, set: { desc: `${mc.desc || mc.label} Some load moves off it.` }, why: 'load moves to the new box' }, { id: st.id, set: { desc: `${st.desc || st.label} The main copy.` }, why: 'there are two now' }],
        remove: dev ? [{ id: dev.id, why: 'it moves with the work and is re-added on the new machine' }] : [],
      },
      edges: {
        add: [{ from: sid, to: mid, kind: 'runs-on', status: 'proposed', label: 'runs here' }, { from: app.id, to: sid, kind: 'runs-on', label: `serves ${app.label}`, mappings: [{ host: 'site-two.example.test', upstream: 'site-two-web:3000', service: 'web' }] }, { from: mid, to: eid, kind: 'calls', status: 'proposed', label: 'its internet line', when: 'run' }, ...(ext ? [{ from: c1, to: ext.id, kind: 'calls', status: 'proposed', label: 'keeps uploads', when: 'run' }] : [])],
        remove: [{ ...ref(runs), why: 'replaced by the new serves line' }],
      },
      scenarios: [
        { id: 'main-down', title: 'The main site loses power', steps: [{ node: st.id, text: 'The main stack is gone with its machine.' }, { node: mid, text: 'The second site keeps answering.' }, { node: app.id, text: 'The app is still up, which is the point.' }] },
        { id: 'line-down', title: 'The second site loses its line', down: [eid], steps: [{ node: eid, text: 'The line is cut.' }, { node: mid, text: 'The box is unreachable.' }, { node: c1, text: 'Nothing on it answers; the main site carries on.' }] },
        { id: 'across-the-map', title: 'A long walk to the new machine', steps: [...walkSteps(w, sayNode).slice(0, 9), { node: mid, text: 'And at the new machine, in another building.' }] },
        { id: 'serves-line', title: 'The app is served from the new stack', steps: [{ edge: { from: app.id, to: sid, kind: 'runs-on' }, text: 'The new serves line.' }, { edge: { from: sid, to: mid, kind: 'runs-on' }, text: 'On the new machine.' }] },
      ],
    };
  });

  return files;
}
