/**
 * Theme and density, persisted in `localStorage`.
 *
 * Three theme states rather than two: `system` follows the OS and is the
 * default, because most people have already told their machine which they
 * want and a dashboard that ignores that is making them ask twice.
 */

const THEME_KEY = 'tokenlens.theme';
const DENSITY_KEY = 'tokenlens.density';
const THEMES = ['system', 'light', 'dark'];

function read(key, fallback, allowed) {
  try {
    const value = window.localStorage.getItem(key);
    return allowed.includes(value) ? value : fallback;
  } catch {
    // Private browsing, or storage disabled. A dashboard that throws
    // because it cannot remember a colour is worse than one that forgets.
    return fallback;
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* nothing to do — the setting simply will not persist */
  }
}

export function initTheme(themeButton, densityButton) {
  let theme = read(THEME_KEY, 'system', THEMES);
  let density = read(DENSITY_KEY, 'comfortable', ['comfortable', 'compact']);

  // The buttons carry an icon and a label; only the label changes, so the
  // icon survives a collapse where the text is hidden.
  const labelOf = (button) => button.querySelector('.tl-side-text') ?? button;

  const applyTheme = () => {
    document.documentElement.dataset.theme = theme;
    labelOf(themeButton).textContent = `Theme: ${theme}`;
    themeButton.setAttribute('title', `Theme: ${theme}. Activate to change.`);
  };

  const applyDensity = () => {
    document.documentElement.dataset.density = density;
    const next = density === 'compact' ? 'Comfortable' : 'Compact';
    labelOf(densityButton).textContent = next;
    densityButton.setAttribute('title', `Switch to ${next.toLowerCase()} density`);
  };

  themeButton.addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    write(THEME_KEY, theme);
    applyTheme();
  });

  densityButton.addEventListener('click', () => {
    density = density === 'compact' ? 'comfortable' : 'compact';
    write(DENSITY_KEY, density);
    applyDensity();
  });

  applyTheme();
  applyDensity();
}
