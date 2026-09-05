import type { HudHistory, HudHistoryPoint, HudHistorySeries } from '@tokenslens/core';
import { credits } from './format.js';

export interface HudHistoryPointView {
  readonly label: string;
  readonly range: string;
  readonly credits: number;
  readonly tokens: number;
  readonly creditsText: string;
  readonly tokensText: string;
  readonly requestsText: string;
}

export interface HudHistorySeriesView {
  readonly period: HudHistorySeries['period'];
  readonly label: string;
  readonly unit: string;
  readonly creditsSummary: string;
  readonly tokensSummary: string;
  readonly points: readonly HudHistoryPointView[];
}

export type HudHistoryView = Readonly<Record<HudHistorySeries['period'], HudHistorySeriesView>>;

function compact(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function shortDay(iso: string): string {
  return utcDate(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function fullDay(iso: string): string {
  return utcDate(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function monthLabel(iso: string, includeYear: boolean): string {
  return utcDate(iso).toLocaleDateString('en-US', {
    month: 'short',
    ...(includeYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}

function pointLabel(point: HudHistoryPoint, period: HudHistorySeries['period']): string {
  return period === 'monthly' ? monthLabel(point.from, false) : shortDay(point.from);
}

function rangeLabel(point: HudHistoryPoint, period: HudHistorySeries['period']): string {
  if (period === 'daily') return fullDay(point.from);
  if (period === 'monthly') return monthLabel(point.from, true);
  return `${fullDay(point.from)} – ${fullDay(point.to)}`;
}

function historySeriesView(series: HudHistorySeries): HudHistorySeriesView {
  const points = series.points.map((point) => {
    const tokens = point.promptTokens + point.outputTokens;
    return {
      label: pointLabel(point, series.period),
      range: rangeLabel(point, series.period),
      credits: point.credits,
      tokens,
      creditsText: `${credits(point.credits)} cr`,
      tokensText: `${compact(tokens)} tokens`,
      requestsText: `${credits(point.requests)} request${point.requests === 1 ? '' : 's'}`,
    };
  });

  const totalCredits = points.reduce((sum, point) => sum + point.credits, 0);
  const totalTokens = points.reduce((sum, point) => sum + point.tokens, 0);
  const divisor = Math.max(1, points.length);
  const unit = series.period === 'daily' ? 'day' : series.period === 'weekly' ? 'week' : 'month';
  const label =
    series.period === 'daily' ? 'Daily' : series.period === 'weekly' ? 'Weekly' : 'Monthly';

  return {
    period: series.period,
    label,
    unit,
    creditsSummary: `${credits(totalCredits)} cr total · ${credits(totalCredits / divisor)} avg / ${unit}`,
    tokensSummary: `${compact(totalTokens)} tokens total · ${compact(totalTokens / divisor)} avg / ${unit}`,
    points,
  };
}

export function toHudHistoryView(history: HudHistory): HudHistoryView {
  return {
    daily: historySeriesView(history.daily),
    weekly: historySeriesView(history.weekly),
    monthly: historySeriesView(history.monthly),
  };
}
