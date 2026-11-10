/*
 * Before the first paint (a classic script, the last thing in the head of explorer/index.html, not a module, so it
 * runs before the body is parsed and the page is drawn): puts the theme on <html data-theme>, so a light page never flashes dark. The
 * same rule as theme-model.js `themeChoiceFrom` and `resolveTheme` (a test holds them together); theme.js
 * takes over once the modules load.
 */
(function () {
  var choice = null;
  try { choice = new URLSearchParams(window.location.search).get('theme'); } catch (e) { /* no address to read */ }
  if (choice !== 'light' && choice !== 'dark' && choice !== 'system') {
    try { choice = window.localStorage.getItem('topology-explorer:theme'); } catch (e) { choice = null; }
  }
  var light = choice === 'light'
    || (choice !== 'dark' && !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches));
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
})();

/*
 * The named themes of the config (`theme.names`, docs/config.md#theme): the server puts them on <html data-theme-names="a b"
 * data-theme-default="a">. This puts the viewer's pick (localStorage, when it is one of them) or the default on
 * <html data-theme-name> before the first paint, and points the named theme's <link id="cf-theme-name-css"> at it (that link comes
 * before this script in the head, so it exists now). Only a plain name (theme-model.js `themeNameHref`) ever reaches the attribute or
 * the URL. The same rule as theme-model.js `themeNameFrom` (a test holds them together).
 */
(function () {
  var root = document.documentElement;
  var names = (root.getAttribute('data-theme-names') || '').split(' ').filter(function (n) { return /^[a-z0-9][a-z0-9-]{0,31}$/.test(n); });
  if (!names.length) return;
  var stored = null;
  try { stored = window.localStorage.getItem('cornfield:theme-name'); } catch (e) { stored = null; }
  var fallback = root.getAttribute('data-theme-default');
  var name = stored && names.indexOf(stored) >= 0 ? stored : (fallback && names.indexOf(fallback) >= 0 ? fallback : '');
  if (name) root.setAttribute('data-theme-name', name); else root.removeAttribute('data-theme-name');
  var link = document.getElementById('cf-theme-name-css');
  if (link) { if (name) link.setAttribute('href', '/cornfield/theme/' + name + '.css'); else link.removeAttribute('href'); }
})();
