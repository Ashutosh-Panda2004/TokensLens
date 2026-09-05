/**
 * Application state, encoded in the URL hash.
 *
 * The hash is the single source of truth for view, scope and date range, so
 * a view survives a refresh, can be bookmarked, and can be pasted to
 * somebody else on the same machine. Keeping it in a module variable
 * instead would make every one of those silently lose the reader's place.
 */

const DEFAULTS = { view: 'overview', scope: 'default', range: 'all', from: '', to: '' };

/**
 * Applies `defaultRange` from config before the hash is parsed.
 *
 * This mutates DEFAULTS rather than setting state, because DEFAULTS is also
 * what `writeHash` omits — seeding state directly would write the default
 * into every URL, and a link shared from one machine would then override the
 * recipient's own configured range.
 */
export function applyServerDefaults(serverDefaults) {
  const range = serverDefaults && serverDefaults.range;
  if (typeof range === 'string' && range !== '') DEFAULTS.range = range;
}

const listeners = new Set();
let state = { ...DEFAULTS };

function parseHash() {
  const raw = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(raw);
  const next = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = params.get(key);
    if (value !== null && value !== '') next[key] = value;
  }
  return next;
}

function writeHash(next) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(next)) {
    if (value !== DEFAULTS[key] && value !== '') params.set(key, value);
  }
  const hash = params.toString();
  const target = `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ''}`;
  window.history.replaceState(null, '', target);
}

export function getState() {
  return { ...state };
}

export function setState(patch, { silent = false } = {}) {
  const next = { ...state, ...patch };
  if (Object.entries(next).every(([key, value]) => state[key] === value)) return;
  state = next;
  writeHash(state);
  if (!silent) for (const listener of listeners) listener(getState());
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initState() {
  state = parseHash();
  window.addEventListener('hashchange', () => {
    state = parseHash();
    for (const listener of listeners) listener(getState());
  });
  return getState();
}

const MS_PER_DAY = 86_400_000;

/**
 * Turns the range selection into the `from`/`to` the API expects.
 *
 * Bounds are UTC calendar days because the ledger buckets by UTC day. Using
 * local midnight here would put a late-evening request in a different bucket
 * from the one the ledger counted it in, and the two views would disagree by
 * one day without either being wrong on its own terms.
 */
export function rangeToQuery(current) {
  const { range, from, to } = current;
  if (range === 'all') return {};
  if (range === 'custom') {
    return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  }

  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (range === 'mtd') {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { from: first.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
  }

  const days = Number.parseInt(range, 10);
  if (!Number.isFinite(days)) return {};
  const start = new Date(today.getTime() - (days - 1) * MS_PER_DAY);
  return { from: start.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
}

/** The scope half of the query — `default` means "whatever the server was started in". */
export function scopeToQuery(current) {
  if (current.scope === 'default') return {};
  return { scope: current.scope };
}

export function toQuery(current) {
  return { ...scopeToQuery(current), ...rangeToQuery(current) };
}
