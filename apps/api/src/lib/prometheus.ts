/**
 * The Prometheus text exposition format (version 0.0.4), by hand: counters, histograms and gauges
 * with labels. Pure (no I/O, no clock), so the format is unit tested without a server.
 *
 * Callers keep label values to a small fixed set (route templates, status classes): every
 * distinct label set is a series held in memory for the life of the process.
 */

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export type Labels = Readonly<Record<string, string>>;

/** Latency buckets in seconds, 5 ms to 10 s. */
export const DEFAULT_DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`invalid metric name: ${name}`);
}

function assertLabelNames(names: readonly string[]): void {
  for (const name of names) {
    // `le` belongs to histogram buckets and `__` names are reserved by Prometheus.
    if (!LABEL_NAME_RE.test(name) || name.startsWith('__') || name === 'le') {
      throw new Error(`invalid label name: ${name}`);
    }
  }
}

/** A label value: backslash, double quote and line feed are escaped. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** HELP text: backslash and line feed are escaped. */
export function escapeHelp(help: string): string {
  return help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** A sample value: integers print without an exponent, infinities and NaN as Prometheus spells them. */
export function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
}

function labelSet(labels: Labels | undefined, extra?: readonly [string, string]): string {
  const pairs = Object.entries(labels ?? {}).map(
    ([name, value]) => `${name}="${escapeLabelValue(value)}"`,
  );
  if (extra !== undefined) pairs.push(`${extra[0]}="${escapeLabelValue(extra[1])}"`);
  return pairs.length === 0 ? '' : `{${pairs.join(',')}}`;
}

function header(name: string, help: string, type: 'counter' | 'gauge' | 'histogram'): string[] {
  return [`# HELP ${name} ${escapeHelp(help)}`, `# TYPE ${name} ${type}`];
}

/** Series key of a label set; label order follows `names`, so callers' key order does not matter. */
function seriesKey(names: readonly string[], labels: Labels): string {
  return names.map((name) => `${name}=${labels[name] ?? ''}`).join('\u0000');
}

function orderedLabels(names: readonly string[], labels: Labels): Labels {
  return Object.fromEntries(names.map((name) => [name, labels[name] ?? '']));
}

export class Counter {
  private readonly series = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: readonly string[] = [],
  ) {
    assertName(name);
    assertLabelNames(labelNames);
  }

  inc(labels: Labels = {}, by = 1): void {
    if (!Number.isFinite(by) || by < 0) throw new Error('a counter only goes up');
    const key = seriesKey(this.labelNames, labels);
    const entry = this.series.get(key);
    if (entry === undefined) {
      this.series.set(key, { labels: orderedLabels(this.labelNames, labels), value: by });
    } else {
      entry.value += by;
    }
  }

  render(): string[] {
    const lines = header(this.name, this.help, 'counter');
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${labelSet(labels)} ${formatValue(value)}`);
    }
    return lines;
  }
}

interface HistogramSeries {
  labels: Labels;
  /** Observations per bucket, NOT cumulative (the last slot is above the highest bound). */
  counts: number[];
  sum: number;
  count: number;
}

export class Histogram {
  private readonly series = new Map<string, HistogramSeries>();
  private readonly bounds: readonly number[];

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: readonly string[] = [],
    buckets: readonly number[] = DEFAULT_DURATION_BUCKETS,
  ) {
    assertName(name);
    assertLabelNames(labelNames);
    if (buckets.length === 0 || buckets.some((bound, i) => !(bound > (buckets[i - 1] ?? -1))))
      throw new Error('histogram buckets must be positive and strictly increasing');
    this.bounds = buckets;
  }

  observe(labels: Labels, value: number): void {
    if (!Number.isFinite(value)) return;
    const key = seriesKey(this.labelNames, labels);
    let entry = this.series.get(key);
    if (entry === undefined) {
      entry = {
        labels: orderedLabels(this.labelNames, labels),
        counts: new Array<number>(this.bounds.length + 1).fill(0),
        sum: 0,
        count: 0,
      };
      this.series.set(key, entry);
    }
    // A value on a bound belongs to that bucket (`le` is "less than or equal").
    const index = this.bounds.findIndex((bound) => value <= bound);
    entry.counts[index === -1 ? this.bounds.length : index]! += 1;
    entry.sum += value;
    entry.count += 1;
  }

  render(): string[] {
    const lines = header(this.name, this.help, 'histogram');
    for (const entry of this.series.values()) {
      let cumulative = 0;
      this.bounds.forEach((bound, i) => {
        cumulative += entry.counts[i] ?? 0;
        lines.push(
          `${this.name}_bucket${labelSet(entry.labels, ['le', formatValue(bound)])} ${cumulative}`,
        );
      });
      lines.push(`${this.name}_bucket${labelSet(entry.labels, ['le', '+Inf'])} ${entry.count}`);
      lines.push(`${this.name}_sum${labelSet(entry.labels)} ${formatValue(entry.sum)}`);
      lines.push(`${this.name}_count${labelSet(entry.labels)} ${entry.count}`);
    }
    return lines;
  }
}

export interface GaugeSample {
  labels?: Labels;
  value: number;
}

/** A gauge family rendered from samples read at scrape time. */
export function renderGauge(name: string, help: string, samples: readonly GaugeSample[]): string[] {
  assertName(name);
  const lines = header(name, help, 'gauge');
  for (const sample of samples) {
    assertLabelNames(Object.keys(sample.labels ?? {}));
    lines.push(`${name}${labelSet(sample.labels)} ${formatValue(sample.value)}`);
  }
  return lines;
}

/** Joins metric families into one exposition body (a trailing newline is required). */
export function renderExposition(families: readonly (readonly string[])[]): string {
  return `${families.map((lines) => lines.join('\n')).join('\n')}\n`;
}
