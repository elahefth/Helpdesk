// shadcn keys its dark tokens off a `.dark` class, but this app has no theme
// switcher — so mirror the OS preference onto <html>.
//
// A file rather than an inline <script>: in production the API serves this
// page under helmet's default Content-Security-Policy, whose `script-src
// 'self'` refuses inline scripts. Loaded synchronously from <head>, so it still
// lands before first paint instead of flashing light first.
(() => {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () =>
    document.documentElement.classList.toggle("dark", query.matches);
  apply();
  query.addEventListener("change", apply);
})();
