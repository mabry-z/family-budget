// Settings → Appearance: Auto / Light / Dark. Applies straight away and is
// remembered on this phone only (see js/theme.js), so it isn't part of Save.
const chips = document.getElementById('appearanceChips');

function showChoice() {
  const choice = window.cadenceAppearance.get();
  chips.querySelectorAll('.chip').forEach(c => c.classList.toggle('selected', c.dataset.value === choice));
}

export function initAppearance() {
  showChoice();
  chips.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    window.cadenceAppearance.set(chip.dataset.value);
    showChoice();
  });
}
