/**
 * @module explorer/engine/piece
 *
 * What every piece of the explorer (explorer/pieces/) does the same way (spec 0011 D3):
 *
 *   scopeOf(inst)             the piece's own end: `listen`, `on`, `timer`, `own` as the instance's, and `destroy()` which takes back every one of them
 *                             (the instance's own `destroy()` runs it too, if the piece is still there)
 *   place(inst, root, html, slots, slot)   makes the piece's elements from `html` and puts them where the host says: before the node `slots[slot]` if
 *                             it is given (cornfield's page leaves a marker comment where each goes), else at the end of `root`; returns the
 *                             elements, which the piece removes on `destroy`. A stand-in the host's markup keeps before the marker for the
 *                             first paint (`<!--corn-placeholder:NAME/SLOT-->` and the piece's markup without ids) goes when the piece comes.
 *                             The markup speaks in the instance's words (`inst.strings`) from the start
 *   withParts(html)           every hook of the markup also gets a `part` of the same name, so a host's stylesheet can reach it
 *                             from outside a shadow root (`::part(row)`)
 */

import { applyStrings } from './strings.js';

const HOOK = new RegExp('\\sdata-corn=\\"([^\\"]+)\\"');
/** An element's data-corn hook is also its part, of the same name (and an element that has a part already keeps it) */
export function withParts(html) {
  return String(html).replace(/<[a-zA-Z][^<>]*>/g, (tag) => (/\spart=/.test(tag) ? tag : tag.replace(HOOK, (_all, hook) => ` data-corn=\"${hook}\" part=\"${hook}\"`)));
}

/**
 * A style the markup wants (a swatch's colour) is written as `data-style="…"` and set here through the CSS object model: an inline `style="…"` that
 * came in as a string is blocked by a host's `style-src 'self'` (spec 0011 D10), and the CSS object model is not.
 */
export function applyStyles(el) {
  const own = el.hasAttribute && el.hasAttribute('data-style') ? [el] : [];
  for (const x of [...own, ...el.querySelectorAll('[data-style]')]) {
    const text = x.getAttribute('data-style') || '';
    x.removeAttribute('data-style');
    // Only the properties a swatch is drawn with, each set on its own: a value can never add a declaration, and never fetches anything
    for (const decl of text.split(';')) {
      const at = decl.indexOf(':');
      if (at < 0) continue;
      const prop = decl.slice(0, at).trim().toLowerCase();
      const value = decl.slice(at + 1).trim();
      if (STYLE_PROPS.has(prop) && value && !UNSAFE_VALUE.test(value)) x.style.setProperty(prop, value);
    }
  }
}
/** What `data-style` may set (the Layers dots and the flow swatches) */
export const STYLE_PROPS = new Set(['background', 'background-color', 'box-shadow', '--hx-dot-ring']);
/** A value that could fetch or escape its declaration: refused */
const UNSAFE_VALUE = /url\(|image|src\(|\\|[<>{}"'@!]/i;

/** Gives every element under `el` that has a hook and no part the part of the same name; applies the styles the markup asks for (`applyStyles`) */
export function addParts(el) {
  for (const x of el.querySelectorAll('[data-corn]:not([part])')) x.setAttribute('part', x.getAttribute('data-corn'));
  applyStyles(el);
}

/**
 * A piece's own end.
 * @param {ReturnType<import('../instance.js').createInstance>} inst
 */
export function scopeOf(inst) {
  const offs = [];
  let done = false;
  const scope = {
    /** Adds a listener; `destroy()` removes it */
    listen(target, type, listener, options) {
      const off = inst.listen(target, type, listener, options);
      offs.push(off);
      return off;
    },
    /** Hears an event of the instance; `destroy()` stops it */
    on(name, fn) {
      const off = inst.on(name, fn);
      offs.push(off);
      return off;
    },
    /** Runs `fn` when the piece ends (a timer's clear, an observer's disconnect); returns `fn` */
    own(fn) {
      offs.push(fn);
      return fn;
    },
    /** A timeout that does not outlive the piece: `destroy()` clears it */
    timeout(fn, ms) {
      const id = setTimeout(() => { fn(); }, ms);
      offs.push(() => clearTimeout(id));
      return id;
    },
    /** Keeps the parts right in `els` as markup is put in them later (the panel's sections, a legend another module fills): a hook gets its part */
    keepParts(...els) {
      const MO = inst.win && inst.win.MutationObserver;
      if (!MO) return;
      const mo = new MO((list) => {
        for (const m of list) {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.hasAttribute('data-corn') && !n.hasAttribute('part')) n.setAttribute('part', n.getAttribute('data-corn'));
            addParts(n); // (and the styles it asks for)
          }
        }
      });
      for (const el of els) mo.observe(el, { childList: true, subtree: true });
      offs.push(() => mo.disconnect());
    },
    /** Ends the piece's part of the instance: runs every clean-up, last first. Safe to call twice. */
    destroy() {
      if (done) return;
      done = true;
      inst.release(scope.destroy);
      while (offs.length) {
        try { offs.pop()(); } catch (err) { console.error('A piece clean-up failed', err); }
      }
    },
  };
  inst.own(scope.destroy);
  return scope;
}

/**
 * Makes elements from `html` and puts them in place. Returns them (the piece removes each on `destroy`).
 * @param {{ doc: Document | null }} inst
 * @param {ParentNode} root where the elements go when the host names no place
 * @param {string} html the markup (it gets its parts)
 * @param {Record<string, Node | null | undefined> | undefined} slots the host's places by name: the node an element goes before
 * @param {string} [slot] this markup's place
 */
export function place(inst, root, html, slots, slot) {
  const template = inst.doc.createElement('template');
  template.innerHTML = withParts(html);
  applyStrings(inst, template.content); // the instance's own words, where its host overrides one (`data-corn-string`): a host need not apply them after
  const made = [...template.content.children];
  const marker = slots && slot ? slots[slot] : null;
  if (marker && marker.parentNode) {
    const stand = standInBefore(marker);
    marker.parentNode.insertBefore(template.content, marker);
    if (stand) takeOver(inst, stand, made);
  } else root.append(template.content);
  return made;
}

/**
 * The stand-in a host's static markup may hold for a piece, so the first paint has it before any script runs (cornfield's header: the
 * Layers chip and the search field). It is the piece's markup without ids, between `<!--corn-placeholder:NAME/SLOT-->` and the piece's
 * own marker, and goes when the piece comes. Returns its nodes, or null when there is none.
 * @param {Node} marker
 */
function standInBefore(marker) {
  const nodes = [];
  const open = `corn-placeholder:${String(marker.data || '').replace(/^corn-piece:/, '')}`;
  for (let n = marker.previousSibling; n; n = n.previousSibling) {
    nodes.push(n);
    if (n.nodeType === 8 && n.data === open) return nodes;
  }
  return null;
}

/** The piece takes the stand-in's place: what was typed in it and the focus carry over to the same control of the piece, and the stand-in goes */
function takeOver(inst, stand, made) {
  const controls = (els) => els.flatMap((el) => (el.nodeType === 1 ? [...(el.matches('button, input') ? [el] : []), ...el.querySelectorAll('button, input')] : []));
  const before = controls(stand.slice().reverse());
  const after = controls(made);
  const active = inst.active();
  before.forEach((el, i) => {
    const next = after[i];
    if (!next || next.tagName !== el.tagName) return;
    if (el.tagName === 'INPUT' && el.value) next.value = el.value;
    if (el === active) next.focus();
  });
  stand.forEach((n) => n.remove());
}
