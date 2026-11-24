import { describe, expect, it } from 'vitest';
import {
  Counter,
  escapeLabelValue,
  formatValue,
  Histogram,
  renderExposition,
  renderGauge,
} from './prometheus';

describe('Histogram', () => {
  it('renders cumulative buckets and an +Inf bucket equal to the count', () => {
    const histogram = new Histogram('latency_seconds', 'Latency.', ['route'], [0.1, 1, 10]);
    for (const value of [0.05, 0.1, 0.5, 5, 50]) histogram.observe({ route: '/a' }, value);
    expect(histogram.render()).toEqual([
      '# HELP latency_seconds Latency.',
      '# TYPE latency_seconds histogram',
      'latency_seconds_bucket{route="/a",le="0.1"} 2',
      'latency_seconds_bucket{route="/a",le="1"} 3',
      'latency_seconds_bucket{route="/a",le="10"} 4',
      'latency_seconds_bucket{route="/a",le="+Inf"} 5',
      'latency_seconds_sum{route="/a"} 55.65',
      'latency_seconds_count{route="/a"} 5',
    ]);
  });

  it('keeps one series per label set and ignores values that are not numbers', () => {
    const histogram = new Histogram('h_seconds', 'H.', ['route'], [1]);
    histogram.observe({ route: '/a' }, 0.5);
    histogram.observe({ route: '/b' }, 2);
    histogram.observe({ route: '/a' }, Number.NaN);
    const text = histogram.render().join('\n');
    expect(text).toContain('h_seconds_count{route="/a"} 1');
    expect(text).toContain('h_seconds_bucket{route="/b",le="1"} 0');
    expect(text).toContain('h_seconds_count{route="/b"} 1');
  });

  it('refuses buckets that are not strictly increasing', () => {
    expect(() => new Histogram('h', 'H.', [], [1, 1])).toThrow();
    expect(() => new Histogram('h', 'H.', [], [])).toThrow();
  });
});

describe('Counter', () => {
  it('adds up per label set whatever the order of the label keys', () => {
    const counter = new Counter('requests_total', 'Requests.', ['route', 'status']);
    counter.inc({ route: '/a', status: '2xx' });
    counter.inc({ status: '2xx', route: '/a' }, 2);
    counter.inc({ route: '/a', status: '5xx' });
    expect(counter.render()).toEqual([
      '# HELP requests_total Requests.',
      '# TYPE requests_total counter',
      'requests_total{route="/a",status="2xx"} 3',
      'requests_total{route="/a",status="5xx"} 1',
    ]);
  });

  it('never goes down', () => {
    expect(() => new Counter('c_total', 'C.').inc({}, -1)).toThrow();
  });

  it('refuses names Prometheus would not accept', () => {
    expect(() => new Counter('bad name', 'C.')).toThrow();
    expect(() => new Counter('c_total', 'C.', ['le'])).toThrow();
  });
});

describe('exposition', () => {
  it('escapes label values and help text', () => {
    expect(escapeLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    const lines = renderGauge('g', 'one\ntwo', [{ labels: { x: 'q"' }, value: 1 }]);
    expect(lines).toEqual(['# HELP g one\\ntwo', '# TYPE g gauge', 'g{x="q\\""} 1']);
  });

  it('spells special values as Prometheus does and ends with a newline', () => {
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe('+Inf');
    expect(formatValue(Number.NaN)).toBe('NaN');
    expect(formatValue(12)).toBe('12');
    const body = renderExposition([
      renderGauge('a', 'A.', [{ value: 1 }]),
      renderGauge('b', 'B.', [{ value: 2 }]),
    ]);
    expect(body).toBe('# HELP a A.\n# TYPE a gauge\na 1\n# HELP b B.\n# TYPE b gauge\nb 2\n');
  });
});
