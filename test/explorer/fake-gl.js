/**
 * Test doubles for the WebGL2 renderer (TOPO-03): there is no GPU in CI, so a fake GL object
 * records every call and a fake canvas hands it out. Never a real context.
 */










/** A WebGL2 context that records every call as `[name, ...args]`; constants (`gl.TRIANGLES`) are their own names */
export function fakeGl(opts                = {}) {
  const log         = [];
  let next = 0;
  const gl      = new Proxy({}, {
    get(_t, key        ) {
      if (key === 'log') return log;
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) return key;
      return (...args       ) => {
        log.push([key, ...args]);
        if (/^create(Shader|Program|Buffer|VertexArray)$/.test(key)) return { id: ++next, made: key };
        if (key === 'getUniformLocation') return { uniform: args[1] };
        if (key === 'getShaderParameter') return !opts.failCompile;
        if (key === 'getProgramParameter') return !opts.failLink;
        if (key === 'getShaderInfoLog' || key === 'getProgramInfoLog') return 'fake driver says no';
        if (key === 'isContextLost') return false;
        return undefined;
      };
    },
  });
  return gl;
}

export const callsOf = (gl     , name        )         => (gl.log          ).filter((c) => c[0] === name);

/** A canvas that gives out `contexts[type]` (null for a type it does not have) and keeps its listeners */
export function fakeCanvas(contexts                      = {}, extra         = {}) {
  const listeners                                       = {};
  const requested           = [];
  const canvas      = {
    width: 0,
    height: 0,
    requested,
    listeners,
    siblings: []         ,
    getContext(type        ) { requested.push(type); return contexts[type] ?? null; },
    addEventListener(type        , fn                  ) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type        , fn                  ) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    /** fires the listeners, as the browser would */
    fire(type        ) {
      const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      (listeners[type] || []).forEach((fn) => fn(event));
      return event;
    },
    after(el     ) { canvas.siblings.push(el); },
    ownerDocument: {
      createElement: () => fakeCanvas({ '2d': recordingCtx() }, { removed: false, className: '', attrs: {}, setAttribute(k        , v        ) { this.attrs[k] = v; }, remove() { this.removed = true; } }),
    },
    ...extra,
  };
  return canvas;
}

/** A 2d context that records every call and every property set */
export function recordingCtx() {
  const log         = [];
  return new Proxy({}, {
    get: (_t, key        ) => (key === 'log' ? log : (...args       ) => { log.push([key, ...args]); }),
    set: (_t, key        , value) => { log.push([`set:${key}`, value]); return true; },
  })       ;
}
