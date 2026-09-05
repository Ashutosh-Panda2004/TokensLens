import { api } from './lib/api.js';
import { el, skeleton } from './lib/dom.js';
import {
  initState,
  getState,
  setState,
  subscribe,
  toQuery,
  applyServerDefaults,
} from './lib/state.js';
import { initTheme } from './lib/theme.js';

import * as overview from './views/overview.js';
import * as projects from './views/projects.js';
import * as waste from './views/waste.js';
import * as models from './views/models.js';
import * as sessions from './views/sessions.js';
import * as tools from './views/tools.js';
import * as budget from './views/budget.js';
import * as day from './views/day.js';
import * as data from './views/data.js';
import * as settings from './views/settings.js';

/**
 * The dashboard shell.
 *
 * Still vanilla ES modules, still no bundler and no framework — D2's
 * decision, kept because a build step on a security-reviewed binary buys
 * very little here. What changed is that 101 lines of one-shot rendering
 * became a routed application with shared state, which is the only way a
 * scope selector and a date filter can drive every panel at once.
 */

const VIEWS = [overview, projects, waste, models, sessions, tools, budget, day, data, settings];
const BY_ID = new Map(VIEWS.map((view) => [view.meta.id, view]));

const dom = {
  nav: document.getElementById('nav'),
  view: document.getElementById('view'),
  viewTitle: document.getElementById('view-title'),
  scopeSelect: document.getElementById('scope-select'),
  scopeLine: document.getElementById('scope-line'),
  rangeSelect: document.getElementById('range-select'),
  customRange: document.getElementById('custom-range'),
  from: document.getElementById('range-from'),
  to: document.getElementById('range-to'),
  updatedAt: document.getElementById('updated-at'),
  refresh: document.getElementById('refresh'),
  themeToggle: document.getElementById('theme-toggle'),
  densityToggle: document.getElementById('density-toggle'),
  navToggle: document.getElementById('nav-toggle'),
  navOpen: document.getElementById('nav-open'),
  navBackdrop: document.getElementById('nav-backdrop'),
  palette: document.getElementById('palette'),
  paletteInput: document.getElementById('palette-input'),
  paletteList: document.getElementById('palette-list'),
};

let scopeInfo = null;
let latestRender = 0;

function buildNav(current) {
  dom.nav.replaceChildren(
    ...VIEWS.filter((view) => !view.meta.hidden).map((view) =>
      el(
        'button',
        {
          type: 'button',
          title: view.meta.label,
          'aria-current': view.meta.id === current ? 'page' : undefined,
          onclick: () => {
            setState({ view: view.meta.id });
            // On a phone the drawer covers the content it just navigated to.
            if (document.documentElement.dataset.nav === 'open') closeDrawer();
          },
        },
        [
          el('span', { className: 'tl-nav-icon', 'aria-hidden': 'true' }, view.meta.icon ?? '○'),
          el('span', { className: 'tl-nav-label' }, view.meta.label),
        ],
      ),
    ),
  );
}

/**
 * The scope line, painted on every render and never conditionally.
 *
 * The defect that created this phase was a correct total that never said
 * whose it was, so a reader standing in an empty folder attributed the
 * whole machine's spend to it.
 */
function paintScopeLine(scope) {
  if (!scope) {
    dom.scopeLine.textContent = '';
    return;
  }

  if (scope.isEverything) {
    dom.scopeLine.textContent = `Showing all ${String(scope.totalWorkspaceCount)} workspace(s) on this machine.`;
    return;
  }

  const where = scope.rootDisplayPath ?? 'the current folder';
  const suffix = scope.mode === 'workspace' ? '' : ' and below';
  dom.scopeLine.textContent =
    `Showing ${where}${suffix} — ${String(scope.matchedWorkspaceCount)} of ` +
    `${String(scope.totalWorkspaceCount)} workspace(s) on this machine.`;
}

function paintScopeOptions(current) {
  const root = scopeInfo?.scope?.rootDisplayPath;
  const options = [
    {
      value: 'default',
      label: root ? `This folder (${leaf(root)}) and below` : 'This folder and below',
    },
    { value: 'workspace', label: 'This workspace only' },
    { value: 'all', label: 'All projects on this machine' },
  ];

  dom.scopeSelect.replaceChildren(
    ...options.map((option) =>
      el('option', { value: option.value, selected: option.value === current.scope }, option.label),
    ),
  );
}

function leaf(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function paintRangeControls(current) {
  dom.rangeSelect.value = current.range;
  dom.customRange.hidden = current.range !== 'custom';
  if (current.from) dom.from.value = current.from;
  if (current.to) dom.to.value = current.to;
}

async function renderView(current) {
  const renderId = ++latestRender;
  const view = BY_ID.get(current.view) ?? overview;

  buildNav(view.meta.id);
  paintRangeControls(current);
  dom.viewTitle.textContent = view.meta.label;
  document.title = `${view.meta.label} · TokenLens`;
  dom.view.dataset.view = view.meta.id;
  dom.view.setAttribute('aria-busy', 'true');
  dom.refresh.classList.add('is-loading');
  dom.refresh.disabled = true;
  dom.view.replaceChildren(skeleton(4));

  try {
    // Scope is refetched with the view so the header cannot end up
    // describing a different selection from the one the figures came from.
    const nextScopeInfo = await api.scope(toQuery(current));
    if (renderId !== latestRender) return;

    scopeInfo = nextScopeInfo;
    paintScopeLine(nextScopeInfo.scope);
    paintScopeOptions(current);

    const nodes = await view.render(current, nextScopeInfo);
    if (renderId !== latestRender) return;

    dom.view.replaceChildren(...[nodes].flat().filter(Boolean));
    dom.updatedAt.textContent = `Updated ${new Date().toLocaleTimeString('en-US')}`;
  } catch (error) {
    if (renderId !== latestRender) return;
    dom.view.replaceChildren(
      el('div', { className: 'tl-error' }, [
        el('strong', {}, 'Could not load this view. '),
        el('span', {}, error instanceof Error ? error.message : String(error)),
      ]),
    );
  } finally {
    if (renderId === latestRender) {
      dom.view.setAttribute('aria-busy', 'false');
      dom.refresh.classList.remove('is-loading');
      dom.refresh.disabled = false;
    }
  }
}

/**
 * Sidebar collapse, persisted.
 *
 * Three states rather than two, because a phone cannot use a 56px icon rail
 * next to content: wide screens toggle expanded/collapsed, narrow ones open
 * and close an off-canvas drawer.
 */
function closeDrawer() {
  document.documentElement.dataset.nav = readNavPreference();
  paintDrawerState();
}

function paintDrawerState() {
  const open = document.documentElement.dataset.nav === 'open';
  dom.navOpen.setAttribute('aria-expanded', String(open));
  dom.navBackdrop.setAttribute('aria-hidden', String(!open));
  dom.navBackdrop.tabIndex = open ? 0 : -1;
}

function readNavPreference() {
  try {
    return window.localStorage.getItem('tokenlens.nav') === 'collapsed' ? 'collapsed' : 'expanded';
  } catch {
    return 'expanded';
  }
}

function wireNav() {
  const root = document.documentElement;
  root.dataset.nav = readNavPreference();

  const setPreference = (value) => {
    const collapsed = value === 'collapsed';
    root.dataset.nav = value;
    dom.navToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    dom.navToggle.textContent = collapsed ? '\u203a' : '\u2039';
    dom.navToggle.title = collapsed ? 'Expand navigation (Ctrl+B)' : 'Collapse navigation (Ctrl+B)';
    dom.navToggle.setAttribute('aria-label', dom.navToggle.title);
    paintDrawerState();
    try {
      window.localStorage.setItem('tokenlens.nav', value);
    } catch {
      /* storage unavailable — the choice simply will not persist */
    }
  };

  setPreference(root.dataset.nav);

  dom.navToggle.addEventListener('click', () => {
    setPreference(root.dataset.nav === 'collapsed' ? 'expanded' : 'collapsed');
  });

  dom.navOpen.addEventListener('click', () => {
    root.dataset.nav = root.dataset.nav === 'open' ? readNavPreference() : 'open';
    paintDrawerState();
  });

  dom.navBackdrop.addEventListener('click', closeDrawer);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && root.dataset.nav === 'open') {
      closeDrawer();
      dom.navOpen.focus();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      setPreference(root.dataset.nav === 'collapsed' ? 'expanded' : 'collapsed');
    }
  });
}

function wireControls() {
  dom.scopeSelect.addEventListener('change', () => setState({ scope: dom.scopeSelect.value }));

  dom.rangeSelect.addEventListener('change', () => {
    const range = dom.rangeSelect.value;
    setState(range === 'custom' ? { range } : { range, from: '', to: '' });
  });

  for (const input of [dom.from, dom.to]) {
    input.addEventListener('change', () =>
      setState({ range: 'custom', from: dom.from.value, to: dom.to.value }),
    );
  }

  dom.refresh.addEventListener('click', () => void renderView(getState()));
}

/** Ctrl/Cmd+K, arrows, Enter — every view reachable without a mouse. */
function wirePalette() {
  let index = 0;
  let returnFocus = null;
  const items = VIEWS.filter((view) => !view.meta.hidden);

  const visible = () => {
    const needle = dom.paletteInput.value.trim().toLowerCase();
    return needle === ''
      ? items
      : items.filter((view) => view.meta.label.toLowerCase().includes(needle));
  };

  const close = () => {
    dom.palette.hidden = true;
    dom.paletteInput.setAttribute('aria-expanded', 'false');
    dom.paletteInput.removeAttribute('aria-activedescendant');
    returnFocus?.focus();
    returnFocus = null;
  };

  const paint = (list) => {
    index = Math.max(0, Math.min(index, Math.max(0, list.length - 1)));
    dom.paletteList.replaceChildren(
      ...list.map((view, position) =>
        el(
          'li',
          {
            id: `palette-option-${view.meta.id}`,
            role: 'option',
            'aria-selected': position === index ? 'true' : 'false',
            onclick: () => {
              close();
              setState({ view: view.meta.id });
            },
          },
          view.meta.label,
        ),
      ),
    );

    const selected = list[index];
    if (selected) {
      dom.paletteInput.setAttribute('aria-activedescendant', `palette-option-${selected.meta.id}`);
      dom.paletteList.children[index]?.scrollIntoView({ block: 'nearest' });
    } else {
      dom.paletteInput.removeAttribute('aria-activedescendant');
    }
  };

  const open = () => {
    returnFocus = document.activeElement;
    index = 0;
    dom.palette.hidden = false;
    dom.paletteInput.value = '';
    dom.paletteInput.setAttribute('aria-expanded', 'true');
    paint(items);
    dom.paletteInput.focus();
  };

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (dom.palette.hidden) open();
      else close();
      return;
    }
    if (dom.palette.hidden) return;

    const list = visible();
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      index = Math.min(index + 1, list.length - 1);
      paint(list);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      index = Math.max(index - 1, 0);
      paint(list);
    } else if (event.key === 'Enter' && list[index]) {
      close();
      setState({ view: list[index].meta.id });
    }
  });

  dom.paletteInput.addEventListener('input', () => {
    index = 0;
    paint(visible());
  });

  dom.palette.addEventListener('click', (event) => {
    if (event.target === dom.palette) close();
  });
}

async function boot() {
  // Settings shape the first paint, so they are fetched before it. A failure
  // here falls through to the built-in defaults rather than blocking the page.
  try {
    applyServerDefaults(await api.defaults());
  } catch {
    // The dashboard is still usable on its built-in defaults.
  }

  const initial = initState();
  initTheme(dom.themeToggle, dom.densityToggle);
  wireNav();
  wireControls();
  wirePalette();
  subscribe((next) => void renderView(next));
  void renderView(initial);
}

void boot();
