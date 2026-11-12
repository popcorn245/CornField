/**
 * The harness page's script (index.html): loads what a host loads for the review piece (the default tokens, then the stylesheets it names, in its order),
 * and mounts up to two reviews in boxes of the sizes the address gives. `window.harness` is what a test drives.
 *
 *   ?objects=WxH   a review fed objects (the topology and a proposal as plain data from /data, no cornfield server)
 *   ?rig=WxH       a review with `base` on the rig (`&base=http://map.corn.localhost:3830`), the proposal fetched by slug
 *   &theme=light|dark   &slug=0100-new-flow-across-apps   &source=pull/21   &view=before|diff|after   &renderer=canvas2d
 *   &shadow=1      each review in the shadow root of a plain custom element (`<review-host>`), as the coming `<corn-review>` will hold it: the stylesheets
 *                  adopted there as constructable sheets (none in the document), the default tokens handed to the piece (`tokens`, the package's
 *                  generated sheet), and nothing in the host page's head for the review. With `?csp=1` (serve.mjs) the page runs under a strict CSP.
 */
import { mount, STYLESHEETS } from '/explorer/pieces/review.js';

const params = new URLSearchParams(location.search);
const theme = params.get('theme') || 'dark';
const shadow = params.get('shadow') === '1';
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

/**
 * For a shadow root: the stylesheets the piece names as constructable sheets, in its order, after one rule of the element's own (it is a block as tall as
 * the place the host gives it), and the default tokens as text for the piece's `tokens` option
 */
async function shadowStyles() {
  const text = (href) => fetch(href).then((r) => { if (!r.ok) throw new Error(`could not load ${href}`); return r.text(); });
  const [tokens, ...css] = await Promise.all(['/tokens.css', ...STYLESHEETS.map((f) => `/explorer/css/${f}`)].map(text));
  const sheet = (source) => { const s = new CSSStyleSheet(); s.replaceSync(source); return s; };
  return { tokens, sheets: [sheet(':host { display: block; width: 100%; height: 100%; }'), ...css.map(sheet)] };
}

/** A plain custom element with an open shadow root: no framework, what a shell does at its least */
class ReviewHost extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }
}
if (!customElements.get('review-host')) customElements.define('review-host', ReviewHost);

const size = (text) => { const m = /^(\d+)x(\d+)$/.exec(text || ''); return m ? { width: Number(m[1]), height: Number(m[2]) } : null; };
const slug = params.get('slug') || '0100-new-flow-across-apps';
const source = params.get('source') || 'pull/21';
const base = params.get('base') || 'http://map.corn.localhost:3830';
const pieces = {};

async function boot() {
  const styles = shadow ? await shadowStyles() : (await loadStyles(), null);
  const fetched = await fetch('/data/topology.json').then((r) => r.json());
  const proposal = await fetch(`/data/proposals/${slug}.json`).then((r) => r.json());
  const make = (name, box, options) => {
    const host = document.querySelector(`[data-box="${name}"]`);
    host.style.width = `${box.width}px`;
    host.style.height = `${box.height}px`;
    document.getElementById(`card-${name}`).hidden = false;
    let root = host;
    if (styles) {
      const el = document.createElement('review-host');
      el.setAttribute('aria-label', `Review: ${name}`);
      host.replaceChildren(el);
      el.shadowRoot.adoptedStyleSheets = styles.sheets;
      root = el.shadowRoot;
    }
    pieces[name] = mount(root, null, { renderer: params.get('renderer') || undefined, theme: 'auto', ...(styles ? { tokens: styles.tokens } : {}), ...options });
    return pieces[name];
  };
  const objects = size(params.get('objects'));
  if (objects) make('objects', objects, { topology: fetched, proposal, slug, source, view: params.get('view') || undefined });
  const rig = size(params.get('rig'));
  if (rig) make('rig', rig, { base, topology: fetched, proposal: slug, source, view: params.get('view') || undefined });
  /** A review in `el` (any element of the page), in a shadow root of its own when the harness is in shadow mode: for tests of boxes of every size and kind */
  const mountIn = (el, options = {}) => {
    let root = el;
    if (styles) { const host = document.createElement('review-host'); el.replaceChildren(host); host.shadowRoot.adoptedStyleSheets = styles.sheets; root = host.shadowRoot; }
    return mount(root, null, { renderer: params.get('renderer') || undefined, theme: 'auto', ...(styles ? { tokens: styles.tokens } : {}), topology: fetched, proposal, ...options });
  };
  window.harness = { pieces, mount: make, mountIn, STYLESHEETS, topology: fetched, proposal, slug, source, base, shadow, root: (name) => (shadow ? document.querySelector(`[data-box="${name}"] review-host`).shadowRoot : document.querySelector(`[data-box="${name}"]`)) };
  document.documentElement.setAttribute('data-harness', 'ready');
}
boot().catch((err) => { console.error('The harness failed', err); document.documentElement.setAttribute('data-harness', 'failed'); });
