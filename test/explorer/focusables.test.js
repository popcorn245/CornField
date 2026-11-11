// @vitest-environment happy-dom
/**
 * The one list of what a focus trap lets the keyboard reach (explorer/focusables.js): every control a Tab stops on, in DOM
 * order, and none that is disabled, hidden, inert or taken out of the order with tabindex -1.
 */
import { describe, it, expect, beforeEach } from 'vitest';
// @ts-expect-error plain JS modules, no declarations
import { focusableIn, trapTab } from '../../explorer/focusables.js';

const tab = (shiftKey = false) => new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });

beforeEach(() => {
  document.body.innerHTML = `<div id="root">
    <a id="link" href="/x">x</a><button id="b1">b</button><button id="off" disabled>d</button>
    <select id="sel"><option>1</option></select><textarea id="ta"></textarea><input id="in"><input id="hid" type="hidden">
    <details><summary id="sum">s</summary></details>
    <span id="tab0" tabindex="0">t</span><span id="tabm" tabindex="-1">m</span><span id="plain">p</span>
    <div hidden><button id="inhidden">h</button></div><div inert><button id="ininert">i</button></div>
    <button id="last">l</button></div>`;
});

describe('focusableIn', () => {
  it('lists selects, textareas, links, summaries and tabindex 0 as well as buttons and inputs, in DOM order', () => {
    expect(focusableIn(document.getElementById('root')).map((e) => e.id)).toEqual(['link', 'b1', 'sel', 'ta', 'in', 'sum', 'tab0', 'last']);
  });
  it('leaves out what is disabled, hidden, inert, type=hidden or tabindex -1', () => {
    const ids = focusableIn(document.getElementById('root')).map((e) => e.id);
    for (const gone of ['off', 'hid', 'tabm', 'plain', 'inhidden', 'ininert']) expect(ids).not.toContain(gone);
  });
  it('is empty for nothing', () => { expect(focusableIn(null)).toEqual([]); });
});

describe('trapTab', () => {
  it('wraps from the last stop to the first, and Shift+Tab the other way, and ignores other keys', () => {
    const root = document.getElementById('root');
    document.getElementById('last').focus();
    const e = tab();
    expect(trapTab(e, root)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement.id).toBe('link');
    trapTab(tab(true), root);
    expect(document.activeElement.id).toBe('last');
    document.getElementById('sel').focus();
    trapTab(tab(), root);
    expect(document.activeElement.id).toBe('ta'); // the select is a stop
    expect(trapTab(new KeyboardEvent('keydown', { key: 'a', cancelable: true }), root)).toBe(false);
  });
  it('holds the key when there is nothing to stop on', () => {
    document.body.innerHTML = '<div id="root"></div>';
    const e = tab();
    trapTab(e, document.getElementById('root'));
    expect(e.defaultPrevented).toBe(true);
  });
});
