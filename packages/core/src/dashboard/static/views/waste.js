import { api } from '../lib/api.js';
import { card, el, empty } from '../lib/dom.js';
import { fmt, pct, taggedChip } from '../lib/format.js';

export const meta = { id: 'waste', label: 'Waste', icon: '⚠' };

export async function render() {
  const board = await api.waste();

  return [summaryCard(board), findingsCard(board), unavailableCard(board)];
}

function summaryCard(board) {
  return card(
    'Attribution',
    'Findings can legitimately overlap — one request may be both on an over-powered model and inside a runaway loop — so these do not sum to the ledger.',
    [
      el('div', { className: 'tl-totals' }, [
        figure('Attributed', fmt(board.attributedCredits)),
        figure('Of ledger', pct(board.attributedShare * 100)),
        figure('Findings', String(board.findings.length)),
        figure('Cannot judge', String(board.unavailable.length)),
      ]),
      board.overlapWarning ? el('p', { className: 'tl-warning' }, board.overlapWarning) : null,
    ],
  );
}

function figure(label, value) {
  return el('div', { className: 'tl-total-figure' }, [
    el('div', { className: 'tl-total-value' }, value),
    el('div', { className: 'tl-total-label' }, label),
  ]);
}

function findingsCard(board) {
  if (board.findings.length === 0) {
    return card('Findings', null, empty('No detector fired on this corpus.'));
  }

  return card(
    'What the credits went on',
    'Expand a finding for its evidence and, more usefully, what to do about it.',
    board.findings.map(renderFinding),
  );
}

function renderFinding(entry) {
  const { finding, guidance } = entry;

  return el('details', { className: 'tl-finding' }, [
    el('summary', {}, [
      el('span', { className: `tl-tier tl-tier-${finding.remediation.tier}` }, finding.class),
      el('span', { className: 'tl-finding-title' }, finding.title),
      el('span', { className: 'tl-finding-credits' }, `${fmt(finding.credits.value)} cr`),
      taggedChip(finding.credits),
    ]),

    el('div', { className: 'tl-finding-body' }, [
      el('p', {}, finding.remediation.summary),
      el(
        'p',
        { className: 'tl-subtle' },
        `Confidence ${(finding.confidence * 100).toFixed(0)}% · tier ${finding.remediation.tier} · fixed by: ${guidance.whoFixesIt}`,
      ),

      fixBlock(guidance, finding),
      evidenceBlock(finding),
    ]),
  ]);
}

/**
 * "How do I fix this?"
 *
 * Every field below already existed and was already computed — the
 * remediation on the finding, the behaviour guidance in the advice module,
 * the mechanism descriptions, the vetted catalogue entry. None of it ever
 * reached the screen. The dashboard showed a credit figure and stopped,
 * which turns a finding into a complaint.
 */
function fixBlock(guidance, finding) {
  const parts = [el('h4', {}, 'How to fix this')];

  parts.push(el('p', {}, [el('strong', {}, 'Change: '), finding.remediation.action]));

  if (guidance.behaviour) {
    parts.push(
      el('p', {}, [el('strong', {}, guidance.behaviour.headline)]),
      el('p', {}, guidance.behaviour.why),
      el(
        'p',
        { className: 'tl-subtle' },
        `You would know it worked when ${guidance.behaviour.howYouWouldKnow}`,
      ),
    );
  }

  if (guidance.tools.length > 0) {
    for (const tool of guidance.tools) {
      parts.push(
        el('div', { className: 'tl-tool' }, [
          el('p', {}, [
            el('strong', {}, tool.name),
            ` — ${tool.summary} `,
            el(
              'span',
              { className: 'tl-subtle' },
              `(${tool.licence}${tool.reversible ? ', reversible' : ''})`,
            ),
          ]),
          el('p', {}, [el('code', {}, tool.installCommand)]),
          el('p', { className: 'tl-subtle' }, tool.repository),
          tool.statusReason ? el('p', { className: 'tl-subtle' }, tool.statusReason) : null,
        ]),
      );
    }
  } else if (guidance.notOfferedReason) {
    // An absence with no explanation reads as an oversight. It is not:
    // nothing is named because the residual gate deliberately stayed shut.
    parts.push(
      el('div', { className: 'tl-tool' }, [
        el('h4', {}, 'Why no tool is recommended'),
        el('p', {}, guidance.notOfferedReason),
        guidance.residual ? el('p', { className: 'tl-subtle' }, guidance.residual) : null,
      ]),
    );
  }

  if (guidance.mechanisms.length > 0) {
    parts.push(
      el('details', { className: 'tl-details' }, [
        el('summary', {}, 'What a tool would have to do'),
        el(
          'ul',
          { className: 'tl-list' },
          guidance.mechanisms.map((mechanism) =>
            el('li', {}, [
              el('strong', {}, mechanism.headline),
              el('div', {}, mechanism.whatItDoes),
              el(
                'div',
                { className: 'tl-subtle' },
                `Observable if it worked: ${mechanism.howYouWouldKnow}`,
              ),
            ]),
          ),
        ),
      ]),
    );
  }

  return el('div', { className: 'tl-fix' }, parts);
}

function evidenceBlock(finding) {
  if (!finding.evidence || finding.evidence.length === 0) {
    return el(
      'p',
      { className: 'tl-subtle' },
      'No per-item evidence was retained for this finding.',
    );
  }

  return el('details', { className: 'tl-details' }, [
    el('summary', {}, `Evidence (${String(finding.evidence.length)})`),
    el(
      'ul',
      { className: 'tl-list tl-evidence' },
      finding.evidence
        .slice(0, 40)
        .map((item) =>
          el('li', {}, [
            el('strong', {}, `${item.kind}: `),
            item.ref,
            ' — ',
            item.detail,
            item.credits !== undefined ? ` (${fmt(item.credits)} cr)` : '',
          ]),
        ),
    ),
  ]);
}

/**
 * The loud abstentions, finally visible to someone who is not reading a
 * terminal. "We found no waste" and "we could not look" are opposite
 * claims, and the whole D11/D12 effort was making the difference sayable.
 */
function unavailableCard(board) {
  if (board.unavailable.length === 0) {
    return card('Classes that could not be judged', null, empty('Every class could be assessed.'));
  }

  return card(
    'Classes that could not be judged',
    'These are not zeros. Each one says what data was missing and what would unblock it.',
    board.unavailable.map((entry) =>
      el('div', { className: 'tl-unavailable' }, [
        el('strong', {}, `${entry.class} — ${entry.name}`),
        el('div', {}, entry.reason),
        el('div', { className: 'tl-unblock' }, `Unblocked by: ${entry.unblockedBy}`),
      ]),
    ),
  );
}

export { pct };
