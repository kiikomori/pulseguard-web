// Runs before first paint (classic script, CSP-safe): apply saved theme, text size and language.
(function () {
  var root = document.documentElement;
  function read(key, fallback) {
    try { return localStorage.getItem("pg." + key) || fallback; } catch (e) { return fallback; }
  }
  root.dataset.theme = read("theme", "system");
  root.dataset.size = read("size", "large");
  root.lang = read("lang", "nl");
})();
