// Light / dark appearance. A plain (non-module) script loaded in <head> so
// the right colours are set before the page first draws. Each phone
// remembers its own choice: 'auto' (follow the phone), 'light' or 'dark'.
// Dark (the original look) until a choice is made.
(function () {
  const KEY = 'cadence-appearance';
  const CHOICES = ['auto', 'light', 'dark'];
  const BAR_COLOURS = { light: '#E4DDD2', dark: '#0A0C10' }; // phone status bar
  const phoneIsLight = window.matchMedia('(prefers-color-scheme: light)');

  let choice = 'dark';
  try {
    const saved = localStorage.getItem(KEY);
    if (CHOICES.includes(saved)) choice = saved;
  } catch { /* storage blocked: stay dark */ }

  function apply() {
    const theme = choice === 'auto' ? (phoneIsLight.matches ? 'light' : 'dark') : choice;
    document.documentElement.dataset.theme = theme;
    const bar = document.querySelector('meta[name="theme-color"]');
    if (bar) bar.content = BAR_COLOURS[theme];
  }

  window.cadenceAppearance = {
    get: () => choice,
    set(next) {
      if (!CHOICES.includes(next)) return;
      choice = next;
      try { localStorage.setItem(KEY, next); } catch { /* remembered for this visit only */ }
      apply();
    },
  };
  phoneIsLight.addEventListener('change', apply);
  document.addEventListener('visibilitychange', apply); // back from the background: re-check the phone
  window.addEventListener('pageshow', apply);
  apply();
})();
