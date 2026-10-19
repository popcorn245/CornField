/*
 * Before the first paint (a classic script in the head of explorer/index.html, not a module, so it runs
 * before the page is drawn): puts the theme on <html data-theme>, so a light page never flashes dark. The
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
