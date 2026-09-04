/**
 * Metrics.
 *
 * Built rather than pulled in, because the whole registry is ~200 lines and a
 * Prometheus client library would be the first runtime dependency in the repo.
 *
 * ## Bucketed histograms, and why the bucket edges are not arbitrary
 *
 * Percentiles from bucketed histograms are approximate — you interpolate
 * within whichever bucket the quantile lands in, so a p50 read off coarse
 * buckets can be off by the bucket's width.
 *
 * That would matter if the question were "what is p50". It is not. The
 * questions in `ARCHITECTURE §12` are *threshold* questions:
 *
 *     p50 TTFT < 400 ms
 *     validator failure < 1%
 *
 * So every SLO threshold gets its own bucket edge. "What fraction of turns
 * were under 400 ms" is then a subtraction of two exact counters, not an
 * interpolation — the gate is answered exactly, and only the cosmetic p50
 * readout is approximate. Buckets are chosen for the question being asked.
 *
 * ## Cardinality
 *
 * Labelled by shop, which is bounded by the number of installs. Never by
 * session or shopper: an unbounded label set is a memory leak that arrives
 * disguised as a dashboard.
 */

export type Labels = Readonly<Record<string, string>>;

/** Hard cap on distinct label combinations per metric. */
const MAX_SERIES = 2_000;

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${labels[k]!}`).join(',');
}

function renderLabels(labels: Labels, extra?: readonly [string, string]): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabel(labels[k]!)}"`);
  if (extra) parts.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  abstract render(): string;
}

export class Counter extends Metric {
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  inc(labels: Labels = {}, by = 1): void {
    const key = labelKey(labels);
    const existing = this.values.get(key);
    if (existing !== undefined) {
      existing.value += by;
      return;
    }
    // Dropping a new series is better than growing without bound; the metric
    // becomes incomplete rather than the process becoming unhealthy.
    if (this.values.size >= MAX_SERIES) return;
    this.values.set(key, { labels, value: by });
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels))?.value ?? 0;
  }

  /** Sum across every label combination. */
  total(): number {
    let n = 0;
    for (const v of this.values.values()) n += v.value;
    return n;
  }

  /**
   * Sum every series matching a subset of labels.
   *
   * `sumWhere({ ok: 'false' })` totals ungrounded turns across all shops. The
   * alternative — keeping a second, shop-free series in parallel — is the kind
   * of bookkeeping that silently drifts out of agreement with itself.
   */
  sumWhere(match: Labels): number {
    let n = 0;
    for (const { labels, value } of this.values.values()) {
      if (Object.entries(match).every(([k, v]) => labels[k] === v)) n += value;
    }
    return n;
  }

  render(): string {
    if (this.values.size === 0) return '';
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join('\n');
  }
}

export class Gauge extends Metric {
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  set(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    if (!this.values.has(key) && this.values.size >= MAX_SERIES) return;
    this.values.set(key, { labels, value });
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels))?.value ?? 0;
  }

  render(): string {
    if (this.values.size === 0) return '';
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join('\n');
  }
}

interface HistogramSeries {
  readonly labels: Labels;
  readonly counts: number[];
  sum: number;
  count: number;
}

export class Histogram extends Metric {
  private readonly series = new Map<string, HistogramSeries>();

  constructor(
    name: string,
    help: string,
    readonly buckets: readonly number[],
  ) {
    super(name, help);
  }

  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (s === undefined) {
      if (this.series.size >= MAX_SERIES) return;
      s = { labels, counts: new Array<number>(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    s.sum += value;
    s.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) s.counts[i]! += 1;
    }
  }

  /**
   * Fraction of observations at or below a threshold.
   *
   * **Exact** when the threshold is one of the bucket edges, which is why the
   * SLO thresholds are bucket edges. Returns `undefined` for a threshold that
   * is not an edge rather than silently interpolating — an SLO answered by
   * guesswork is worse than one that admits it cannot be answered.
   */
  fractionAtOrBelow(threshold: number, labels: Labels = {}): number | undefined {
    const s = this.series.get(labelKey(labels));
    if (s === undefined || s.count === 0) return undefined;
    const i = this.buckets.indexOf(threshold);
    if (i === -1) return undefined;
    return s.counts[i]! / s.count;
  }

  /** Approximate quantile by linear interpolation. For display, not for gates. */
  quantile(q: number, labels: Labels = {}): number | undefined {
    const s = this.series.get(labelKey(labels));
    if (s === undefined || s.count === 0) return undefined;

    const target = q * s.count;
    let prevEdge = 0;
    let prevCount = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      const cumulative = s.counts[i]!;
      if (cumulative >= target) {
        const inBucket = cumulative - prevCount;
        if (inBucket === 0) return prevEdge;
        const edge = this.buckets[i]!;
        if (!Number.isFinite(edge)) return prevEdge;
        return prevEdge + ((target - prevCount) / inBucket) * (edge - prevEdge);
      }
      prevCount = cumulative;
      prevEdge = this.buckets[i]!;
    }
    // Everything above the last finite bucket; the mean is a better guess than
    // the last edge, which would understate a long tail.
    return s.count === 0 ? undefined : s.sum / s.count;
  }

  count(labels: Labels = {}): number {
    return this.series.get(labelKey(labels))?.count ?? 0;
  }

  render(): string {
    if (this.series.size === 0) return '';
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const s of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        const edge = this.buckets[i]!;
        const le = Number.isFinite(edge) ? String(edge) : '+Inf';
        lines.push(`${this.name}_bucket${renderLabels(s.labels, ['le', le])} ${s.counts[i]!}`);
      }
      // Prometheus requires an +Inf bucket equal to the total count.
      if (Number.isFinite(this.buckets[this.buckets.length - 1])) {
        lines.push(`${this.name}_bucket${renderLabels(s.labels, ['le', '+Inf'])} ${s.count}`);
      }
      lines.push(`${this.name}_sum${renderLabels(s.labels)} ${s.sum}`);
      lines.push(`${this.name}_count${renderLabels(s.labels)} ${s.count}`);
    }
    return lines.join('\n');
  }
}

export class Registry {
  private readonly metrics: Metric[] = [];

  counter(name: string, help: string): Counter {
    const m = new Counter(name, help);
    this.metrics.push(m);
    return m;
  }

  gauge(name: string, help: string): Gauge {
    const m = new Gauge(name, help);
    this.metrics.push(m);
    return m;
  }

  histogram(name: string, help: string, buckets: readonly number[]): Histogram {
    const m = new Histogram(name, help, buckets);
    this.metrics.push(m);
    return m;
  }

  /** Prometheus text exposition format. */
  render(): string {
    return (
      this.metrics
        .map((m) => m.render())
        .filter((s) => s !== '')
        .join('\n\n') + '\n'
    );
  }
}
