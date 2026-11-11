/**
 * @module server/page-head
 *
 * The `<head>` lines a page of cornfield's takes from the config: the brand's favicon and tab colour, the theme's font stylesheets and
 * stylesheets, the named themes on `<html>`. The explorer (server/server.js) and the sign-in pages (server/auth.js) both read them, so a
 * brand and a theme reach the page a signed-out visitor sees as well as the one behind it.
 */

import { MANIFEST_PATH, brandImages, colorOf } from '../core/brand.js';
import { THEME_NAME, fontUrl } from '../core/theme.js';

export const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The config's theme names that may reach the page: plain ones only (core/theme.js THEME_NAME), and the default when it is one of them */
export function themeNamesOf(theme) {
  const names = Object.keys(theme.names || {}).filter((n) => THEME_NAME.test(n));
  return { names, fallback: theme.default && names.includes(theme.default) ? theme.default : null };
}

/** `<html>` with the named themes on it, for theme-boot.js to read before the first paint */
export function themeHtmlTag(theme) {
  const { names, fallback } = themeNamesOf(theme);
  return names.length ? `<html lang="en" data-theme-names="${names.join(' ')}"${fallback ? ` data-theme-default="${fallback}"` : ''}>` : '<html lang="en">';
}

/**
 * The links that go after cornfield's own stylesheets, in this order: the allow-listed font stylesheets, the repo's theme.css, and the
 * default named theme. explorer/index.html includes theme-boot.js once, after these, so it points that link at the viewer's choice
 * before the first paint. Always links, never inlined CSS.
 */
export function themeHead(theme) {
  const out = [];
  for (const f of theme.fonts || []) {
    const u = fontUrl(f);
    if (u) out.push(`<link rel="stylesheet" href="${escapeHtml(u.href)}" referrerpolicy="no-referrer" />`);
  }
  if (theme.css) out.push('<link rel="stylesheet" href="/cornfield/theme.css" data-corn-theme="css" />');
  const { names, fallback } = themeNamesOf(theme);
  if (names.length) out.push(`<link rel="stylesheet" id="cf-theme-name-css"${fallback ? ` href="/cornfield/theme/${fallback}.css"` : ''} data-corn-theme="name" />`);
  return out.join('\n  ');
}

/**
 * The `<head>` lines of a brand: the favicon, the manifest (always, so any cornfield installs as an app; fetched with the sign-in
 * cookie, since the page is behind it) and the tab colour
 */
export function brandHead(brand, { manifest = true } = {}) {
  const out = [];
  const favicon = brandImages(brand).find((i) => i.key === 'favicon');
  if (favicon) out.push(`<link rel="icon" href="${escapeHtml(favicon.url)}" type="${favicon.type}" />`);
  if (manifest) out.push(`<link rel="manifest" href="${MANIFEST_PATH}" crossorigin="use-credentials" />`);
  const color = colorOf(brand && brand.color);
  if (color) out.push(`<meta name="theme-color" content="${escapeHtml(color)}" />`);
  return out.join('\n  ');
}
