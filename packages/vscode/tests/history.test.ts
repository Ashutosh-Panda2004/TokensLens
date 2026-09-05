import { describe, expect, it } from 'vitest';
import type { HudHistory } from '@tokenslens/core';
import { toHudHistoryView } from '../src/history.js';

const history: HudHistory = {
  daily: {
    period: 'daily',
    points: [
      {
        from: '2026-08-01',
        to: '2026-08-01',
        credits: 10,
        promptTokens: 1_000,
        outputTokens: 500,
        requests: 1,
      },
      {
        from: '2026-08-02',
        to: '2026-08-02',
        credits: 20,
        promptTokens: 2_000,
        outputTokens: 500,
        requests: 2,
      },
    ],
  },
  weekly: {
    period: 'weekly',
    points: [
      {
        from: '2026-07-27',
        to: '2026-08-02',
        credits: 30,
        promptTokens: 3_000,
        outputTokens: 1_000,
        requests: 3,
      },
    ],
  },
  monthly: {
    period: 'monthly',
    points: [
      {
        from: '2026-08-01',
        to: '2026-08-02',
        credits: 30,
        promptTokens: 3_000,
        outputTokens: 1_000,
        requests: 3,
      },
    ],
  },
};

describe('toHudHistoryView', () => {
  it('formats daily credits, tokens, requests and UTC labels', () => {
    const view = toHudHistoryView(history);

    expect(view.daily.creditsSummary).toBe('30 cr total · 15 avg / day');
    expect(view.daily.tokensSummary).toBe('4K tokens total · 2K avg / day');
    expect(view.daily.points[0]).toMatchObject({
      label: 'Aug 1',
      range: 'August 1, 2026',
      creditsText: '10 cr',
      tokensText: '1.5K tokens',
      requestsText: '1 request',
    });
    expect(view.daily.points[1]?.requestsText).toBe('2 requests');
  });

  it('states weekly ranges and month labels without local-time drift', () => {
    const view = toHudHistoryView(history);

    expect(view.weekly.points[0]?.range).toBe('July 27, 2026 – August 2, 2026');
    expect(view.monthly.points[0]).toMatchObject({ label: 'Aug', range: 'Aug 2026' });
  });

  it('keeps empty bounded series renderable', () => {
    const empty: HudHistory = {
      daily: { period: 'daily', points: [] },
      weekly: { period: 'weekly', points: [] },
      monthly: { period: 'monthly', points: [] },
    };

    const view = toHudHistoryView(empty);
    expect(view.daily.points).toEqual([]);
    expect(view.daily.creditsSummary).toBe('0 cr total · 0 avg / day');
    expect(view.monthly.tokensSummary).toBe('0 tokens total · 0 avg / month');
  });
});
