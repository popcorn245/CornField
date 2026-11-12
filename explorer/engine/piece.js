/**
 * @module explorer/engine/piece
 *
 * What every piece of the explorer (explorer/pieces/) does the same way (spec 0011 D3):
 *
 *   scopeOf(inst)             the piece's own end: `listen`, `on`, `timer`, `own` as the instance's, and `destroy()` which takes back every one of them
 *                             (the instance's own `destroy()` runs it too, if the piece is still there)
 *   place(inst, root, html, slots, slot)   makes the piece's elements from `html` and puts them where the host says: before the node `slots[slot]` if
 *                             it is given (cornfield's page leaves a marker comment where each goes), else at the end of `root`; returns the
 *                             elements, which the piece removes on `destroy`
 *   withParts(html)           every hook of the markup also gets a `part` of the same name, so a host's stylesheet can reach it
 *                             from outside a shadow root (`::part(row)`)
 */

const HOOK = new RegExp('\\sdata-corn=\\"([^\\"]+)\\"');
/** An element's data-corn hook is also its part, of the same name (and an element that has a part already keeps it) */
export function withParts(html) {
  return String(html).replace(/<[a-zA-Z][^<>]*>/g, (tag) => (/\spart=/.test(tag) ? tag : tag.replace(HOOK, (_all, hook) => ` data-corn=\"${hook}\" part=\"${hook}\"`)));
}

/** Gives every element under `el` that has a hook and no part the part of the same name */
export function addParts(el) {
  for (const x of el.querySelectorAll('[data-corn]:not([part])')) x.setAttribute('part', x.getAttribute('data-corn'));
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
            addParts(n);
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
  const made = [...template.content.children];
  const marker = slots && slot ? slots[slot] : null;
  if (marker && marker.parentNode) marker.parentNode.insertBefore(template.content, marker);
  else root.append(template.content);
  return made;
}
