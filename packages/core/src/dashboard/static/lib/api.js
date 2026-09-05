/**
 * The API client.
 *
 * The launch URL carries `?token=`; every subsequent fetch sends it as a
 * bearer header instead, so the token stops appearing in the address bar
 * the moment the page has read it once.
 */
const token = new URLSearchParams(window.location.search).get('token') ?? '';

async function get(path, params = {}) {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (!response.ok) {
    // The server explains a refused range or an unknown day in prose; a bare
    // status code would send the reader to the network tab to find out what
    // they typed wrong.
    let detail = `HTTP ${String(response.status)}`;
    try {
      const body = await response.json();
      if (body?.detail) detail = body.detail;
      else if (body?.error) detail = body.error;
    } catch {
      /* not JSON — the status is all there is */
    }
    throw new Error(detail);
  }

  return response.json();
}

/** The monthly report is Markdown, not JSON, so it needs its own reader. */
async function getText(path, params = {}) {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return response.text();
}

/** Scope and range are appended to every query from one place, so no view can forget them. */
function scoped(params, query) {
  return {
    ...params,
    scope: query.scope,
    at: query.at,
    from: query.from,
    to: query.to,
  };
}

/**
 * The only write in the client.
 *
 * The token goes in the `Authorization` header and never the query string,
 * and the body is JSON — both are required by the server, and together they
 * force a CORS preflight that a cross-site form post cannot satisfy.
 */
async function post(path, body) {
  const response = await fetch(new URL(path, window.location.origin), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const parsed = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = parsed?.detail;
    throw new Error(
      Array.isArray(detail)
        ? detail.join(' ')
        : (detail ?? parsed?.error ?? `HTTP ${String(response.status)}`),
    );
  }
  return parsed;
}

export const api = {
  defaults: () => get('/api/defaults'),
  scope: (query) => get('/api/scope', scoped({}, query)),
  projects: () => get('/api/projects'),
  ledger: (query) => get('/api/ledger', scoped({}, query)),
  timeseries: (query) => get('/api/timeseries', scoped({}, query)),
  budget: (query) => get('/api/budget', scoped({}, query)),
  waste: () => get('/api/waste'),
  mcpRoi: () => get('/api/mcp-roi'),
  anomalies: (query) => get('/api/anomalies', scoped({}, query)),
  compare: (query) => get('/api/compare', scoped({}, query)),
  day: (date) => get(`/api/day/${date}`),
  verify: (requestId) => get(`/api/verify/${requestId}`),
  settings: () => get('/api/settings'),
  saveSettings: (layer, settings) => post('/api/settings', { layer, settings }),
  consent: () => get('/api/consent'),
  consentPreview: () => get('/api/consent/preview'),
  setConsent: (share) => post('/api/consent', { share }),
  reports: (query) => get('/api/reports', scoped({}, query)),
  report: (period, query) => getText('/api/report', scoped({ period }, query)),
};

export { token };
