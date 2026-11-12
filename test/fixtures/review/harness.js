/**
 * The harness page's script (index.html): loads what a host loads for the review piece (the default tokens, then the stylesheets it names, in its order),
 * and mounts up to two reviews in boxes of the sizes the address gives. `window.harness` is what a test drives.
 *
 *   ?objects=WxH   a review fed objects (the topology and a proposal as plain data from /data, no cornfield server)
 *   ?rig=WxH       a review with `base` on the rig (`&base=http://map.corn.localhost:3830`), the proposal fetched by slug
 *   &theme=light|dark   &slug=0100-new-flow-across-apps   &source=pull/21   &view=before|diff|after   &renderer=canvas2d
 */
import { mount, STYLESHEETS } from '/explorer/pieces/review.js';

const params = new URLSearchParams(location.search);
const theme = params.get('theme') || 'dark';
document.documentElement.setAttribute('data-theme', theme);

/** The default tokens and each stylesheet the piece names, in order, loaded before anything mounts */
async function loadStyles() {
  const hrefs = ['/explorer/tokens.css', ...STYLESHEETS.map((f) => `/explorer/css/${f}`)];
  await Promise.all(hrefs.map((href) => new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = resolve;
    link.onerror = () => reject(new Error(`could not load ${href}`));
    document.head.append(link);
  })));
}

const size = (text) => { const m = /^(\d+)x(\d+)$/.exec(text || ''); return m ? { width: Number(m[1]), height: Number(m[2]) } : null; };
const slug = params.get('slug') || '0100-new-flow-across-apps';
const source = params.get('source') || 'pull/21';
const base = params.get('base') || 'http://map.corn.localhost:3830';
const pieces = {};

async function boot() {
  await loadStyles();
  const fetched = await fetch('/data/topology.json').then((r) => r.json());
  const proposal = await fetch(`/data/proposals/${slug}.json`).then((r) => r.json());
  const make = (name, box, options) => {
    const host = document.querySelector(`[data-box="${name}"]`);
    host.style.width = `${box.width}px`;
    host.style.height = `${box.height}px`;
    document.getElementById(`card-${name}`).hidden = false;
    pieces[name] = mount(host, null, { renderer: params.get('renderer') || undefined, theme: 'auto', ...options });
    return pieces[name];
  };
  const objects = size(params.get('objects'));
  if (objects) make('objects', objects, { topology: fetched, proposal, slug, source, view: params.get('view') || undefined });
  const rig = size(params.get('rig'));
  if (rig) make('rig', rig, { base, topology: fetched, proposal: slug, source, view: params.get('view') || undefined });
  window.harness = { pieces, mount: make, STYLESHEETS, topology: fetched, proposal, slug, source, base };
  document.documentElement.setAttribute('data-harness', 'ready');
}
boot().catch((err) => { console.error('The harness failed', err); document.documentElement.setAttribute('data-harness', 'failed'); });
