/**
 * @module explorer/pieces/adopt-tokens
 *
 * The default `--corn-*` tokens for a page that has no cornfield stylesheet of its own (spec 0011 D7). The package generates the sheet from
 * explorer/tokens.css at build time, with every selector at zero specificity (`:where(...)`), so any ordinary rule of the host's overrides it; the
 * first `corn-*` element to connect hands its text to this, and it is added once to the document (and once to a shadow root the element sits in).
 */

/** Marks the sheet this module made, so a second copy of the package on the same page finds it and adds nothing */
const MARK = Symbol.for('cornfield.default-tokens');
const ATTR = 'data-corn-default-tokens';

/**
 * Adds `css` to the root node the element is in (a document or a shadow root), once. Returns true when it added it.
 * Uses `adoptedStyleSheets`; a browser without it gets a `<style>` placed first in the head (or the shadow root), which loses to every later rule the same way.
 * @param {Document|ShadowRoot} rootNode `element.getRootNode()`
 * @param {string} css the generated default tokens
 */
export function adoptDefaultTokens(rootNode, css) {
  if (!rootNode || !css) return false;
  const doc = rootNode.nodeType === 9 ? rootNode : rootNode.ownerDocument;
  const sheets = rootNode.adoptedStyleSheets;
  if (Array.isArray(sheets) && doc && doc.defaultView && typeof doc.defaultView.CSSStyleSheet === 'function' && 'replaceSync' in doc.defaultView.CSSStyleSheet.prototype) {
    if (sheets.some((s) => s && s[MARK])) return false;
    const sheet = new doc.defaultView.CSSStyleSheet();
    sheet.replaceSync(css);
    sheet[MARK] = true;
    rootNode.adoptedStyleSheets = [...sheets, sheet];
    return true;
  }
  const holder = rootNode.nodeType === 9 ? rootNode.head : rootNode;
  if (!holder || holder.querySelector(`style[${ATTR}]`)) return false;
  const style = doc.createElement('style');
  style.setAttribute(ATTR, '');
  style.textContent = css;
  holder.prepend(style);
  return true;
}
