/*
 * Runs synchronously in <head>, before the first paint, so a stored choice never flashes the
 * other theme. It reads one key and sets one attribute. Anything odd (private mode, blocked
 * site data, no storage) means no attribute, and theme.css then follows the system setting.
 * A classic script on purpose: a module would run after the first paint. The buttons that
 * change the theme live in app/theme.js.
 */
(function () {
  try {
    var theme = localStorage.getItem('theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  } catch (e) { /* storage unavailable: the system setting decides */ }
})();
