import { api } from '../lib/api.js';
import { card, el, empty } from '../lib/dom.js';
import { fmt } from '../lib/format.js';

export const meta = { id: 'settings', label: 'Settings', icon: '⚙' };

const SOURCE_TEXT = {
  flag: 'a --allowance flag on the command that started this server',
  env: 'the TOKENLENS_MONTHLY_ALLOWANCE environment variable',
  config: 'this project’s .tokenlens/config.json',
  'user-config': 'your machine-wide ~/.tokenlens/config.json',
  'plan-default': 'the published figure for the plan — nobody has set a real one',
};

export async function render() {
  let settings;
  try {
    settings = await api.settings();
  } catch {
    return [
      card(
        'Settings',
        null,
        empty(
          'This server was started without the settings surface, so nothing can be changed here.',
        ),
      ),
    ];
  }

  let consent = null;
  try {
    consent = await api.consent();
  } catch {
    // Sharing is simply not offered if the endpoint is unavailable.
  }

  const cards = [effectiveCard(settings), formCard(settings)];
  if (consent) cards.push(contributeCard(consent));
  cards.push(whereCard(settings));
  return cards;
}

/**
 * Opting in to anonymous sharing.
 *
 * The toggle is last and starts off. Everything above it is disclosure: the
 * manifest of what would leave, a link to the exact payload, and the fact
 * that nothing is uploaded. A switch presented without those is not a
 * consent mechanism, it is a dark pattern.
 */
function contributeCard(consent) {
  const status = el(
    'p',
    { className: 'tl-subtle' },
    consent.sharing
      ? `Sharing is ON since ${consent.consentedAt}.`
      : (consent.reasonText ?? 'Sharing is OFF.'),
  );

  const payload = el('pre', { className: 'tl-pre', hidden: true }, '');

  const preview = el(
    'button',
    {
      type: 'button',
      className: 'tl-button',
      onclick: async () => {
        if (!payload.hidden) {
          payload.hidden = true;
          return;
        }
        payload.textContent = 'Building…';
        payload.hidden = false;
        try {
          const result = await api.consentPreview();
          payload.textContent = JSON.stringify(result.contribution, null, 2);
        } catch (error) {
          payload.textContent = `Could not build a preview: ${String(error)}`;
        }
      },
    },
    'Show me exactly what would be shared',
  );

  const pill = el(
    'span',
    { className: consent.sharing ? 'tl-state-pill tl-state-on' : 'tl-state-pill' },
    consent.sharing ? 'Sharing is ON' : 'Sharing is OFF',
  );

  const toggle = el(
    'button',
    {
      type: 'button',
      // Primary only when it would turn sharing ON: the emphasised button is
      // the one that changes what leaves the machine, and it should look
      // like a decision rather than a link.
      className: consent.sharing ? 'tl-button' : 'tl-button tl-button-primary',
      onclick: async () => {
        toggle.disabled = true;
        status.textContent = 'Saving…';
        try {
          const result = await api.setConsent(!consent.sharing);
          consent.sharing = result.sharing;
          toggle.textContent = result.sharing ? 'Turn sharing off' : 'Turn sharing on';
          toggle.className = result.sharing ? 'tl-button' : 'tl-button tl-button-primary';
          pill.textContent = result.sharing ? 'Sharing is ON' : 'Sharing is OFF';
          pill.className = result.sharing ? 'tl-state-pill tl-state-on' : 'tl-state-pill';
          status.textContent = result.sharing
            ? `Agreed ${result.consentedAt}. Nothing has been sent — produce this month with: tokenlens contribute run`
            : 'Nothing further will be produced.';
        } catch (error) {
          status.textContent = `Could not save: ${String(error)}`;
        } finally {
          toggle.disabled = false;
        }
      },
    },
    consent.sharing ? 'Turn sharing off' : 'Turn sharing on',
  );

  return card('Share anonymous monthly aggregates', null, [
    el(
      'p',
      { className: 'tl-subtle' },
      'Pooled across many installs, these figures show which models, cost centres and waste classes actually dominate spend — the one question your own data cannot answer about itself. Entirely optional, off by default, and reversible at any time.',
    ),
    el('p', { className: 'tl-subtle' }, 'What would leave this machine, in full:'),
    el(
      'ul',
      { className: 'tl-list' },
      consent.manifest.map((entry) =>
        el('li', {}, [el('strong', {}, `${entry.field}: `), entry.why]),
      ),
    ),
    el(
      'p',
      { className: 'tl-subtle' },
      'Nothing else. No prompts, completions, file paths, file contents, tool arguments, session ids, repository names, or timestamps finer than a day. Absent, not redacted.',
    ),
    el(
      'p',
      { className: 'tl-subtle' },
      `TokenLens never uploads anything. A contribution is written to ${consent.outbox} and stays there until you send it yourself.`,
    ),
    el('div', { className: 'tl-controls tl-controls-spaced' }, [pill, toggle, preview]),
    status,
    payload,
  ]);
}

/**
 * What is in force, and why.
 *
 * Shown above the form rather than below it because the answer to "why did
 * my change do nothing" is almost always precedence — and a page that only
 * showed the form would let a reader save into a layer that something more
 * specific is already overriding.
 */
function effectiveCard(settings) {
  const allowance = settings.allowance;
  const text =
    allowance.credits === null
      ? 'unlimited — no monthly limit'
      : `${fmt(allowance.credits, 0)} credits`;

  return card('In force right now', null, [
    el('div', { className: 'tl-budget-grid' }, [
      item('Plan', allowance.plan),
      item('Monthly allowance', text),
      item('Set by', SOURCE_TEXT[allowance.source] ?? allowance.source),
    ]),
    settings.overriddenByEnv
      ? el(
          'p',
          { className: 'tl-warning' },
          `${settings.overriddenByEnv} is set in this server’s environment and outranks both config ` +
            'files. Saving below will be recorded, but the figure in force will not change until that ' +
            'variable is unset.',
        )
      : null,
  ]);
}

function item(label, value) {
  return el('div', { className: 'tl-budget-item' }, [
    el('div', { className: 'tl-budget-label' }, label),
    el('div', { className: 'tl-budget-value tl-definition-value' }, String(value)),
  ]);
}

/** Per-field provenance, so no value on this page looks configured when it is only a default. */
const FIELD_SOURCE_TEXT = {
  env: 'an environment variable',
  'project-config': 'this project (./.tokenlens/config.json)',
  'user-config': 'this machine (~/.tokenlens/config.json)',
  default: 'the built-in default',
};

function formCard(settings) {
  const inputs = new Map();
  const status = el('p', { className: 'tl-subtle' }, '');

  const rows = settings.fields.map((field) => {
    const current = settings.effective[field.key];
    const input =
      field.kind === 'choice'
        ? el('select', { id: `set-${field.key}` }, [
            el('option', { value: '' }, '— not set —'),
            ...field.choices.map((choice) =>
              el('option', { value: choice, selected: String(current ?? '') === choice }, choice),
            ),
          ])
        : el('input', {
            id: `set-${field.key}`,
            type: 'text',
            value: current === undefined || current === null ? '' : String(current),
            placeholder: field.kind === 'allowance' ? 'e.g. 3900 or unlimited' : 'e.g. 7331',
          });

    inputs.set(field.key, input);

    return el('div', { className: 'tl-setting-row' }, [
      el('label', { className: 'tl-setting-label', for: `set-${field.key}` }, field.label),
      input,
      el('p', { className: 'tl-subtle' }, field.help),
      el('p', { className: 'tl-subtle' }, `Affects: ${field.affects}`),
      el(
        'p',
        { className: 'tl-subtle' },
        `Currently set by: ${FIELD_SOURCE_TEXT[(settings.sources || {})[field.key]] ?? 'the built-in default'}`,
      ),
    ]);
  });

  const layer = el('select', { id: 'set-layer', 'aria-label': 'Where to save' }, [
    el('option', { value: 'user', selected: true }, 'This machine — every project (~/.tokenlens/)'),
    el('option', { value: 'project' }, 'This project only (./.tokenlens/)'),
  ]);

  const save = el(
    'button',
    {
      type: 'button',
      className: 'tl-button tl-button-primary',
      onclick: async () => {
        const patch = {};
        for (const [key, input] of inputs) {
          // An empty field means "leave this to the layer below", which is
          // different from writing a zero.
          patch[key] = input.value.trim() === '' ? null : input.value.trim();
        }

        status.textContent = 'Saving…';
        try {
          const result = await api.saveSettings(layer.value, patch);
          status.textContent = `Saved to ${result.path}. Now in force: ${
            result.allowance.credits === null
              ? 'unlimited'
              : `${fmt(result.allowance.credits, 0)} credits`
          } (${SOURCE_TEXT[result.allowance.source] ?? result.allowance.source}).`;
          status.className = 'tl-subtle';
        } catch (error) {
          // Validation failures come back as prose from the server; showing
          // the raw message is more useful than "could not save".
          status.textContent = error instanceof Error ? error.message : String(error);
          status.className = 'tl-error';
        }
      },
    },
    'Save settings',
  );

  return card(
    'Change settings',
    'Written to a JSON file on this machine. Nothing is sent anywhere — this server has no outbound network access.',
    [
      ...rows,
      el('div', { className: 'tl-setting-row' }, [
        el('label', { className: 'tl-setting-label', for: 'set-layer' }, 'Save to'),
        layer,
        el(
          'p',
          { className: 'tl-subtle' },
          'The ledger spans every workspace on this machine, so the allowance usually belongs at machine level. A project file overrides it where it applies.',
        ),
      ]),
      el('div', { className: 'tl-controls tl-controls-spaced' }, [save, status]),
    ],
  );
}

function whereCard(settings) {
  return card('Where these live', null, [
    el('ul', { className: 'tl-list' }, [
      el('li', {}, [el('strong', {}, 'Machine: '), el('code', {}, settings.paths.user)]),
      el('li', {}, [el('strong', {}, 'Project: '), el('code', {}, settings.paths.project)]),
    ]),
    el(
      'p',
      { className: 'tl-subtle' },
      'Precedence, most specific first: command-line flag → environment variable → project file → machine file → plan default.',
    ),
    el(
      'p',
      { className: 'tl-subtle' },
      'These files are shared. The tokenlens CLI and the VS Code extension read the same two layers, so a change here reaches all three — run tokenlens config to see what any of them is using.',
    ),
    el(
      'p',
      { className: 'tl-subtle' },
      'Theme and density are deliberately not stored here — they are per-browser preferences and live in this browser’s local storage.',
    ),
  ]);
}
