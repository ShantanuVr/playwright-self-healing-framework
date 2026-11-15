/**
 * @file ITelemetryExporter.ts
 * @description Telemetry abstraction, plus the single place that decides
 *              WHAT gets exported. Exporters only serialise and ship these
 *              points, so every backend reports identical numbers.
 *
 * Only `strategy` and `logical_name` are ever used as labels: cardinality
 * stays bounded, and no selector, page text or DOM leaves the machine.
 */

import { HealingOutcome } from '../storage/ElementMetaData';

export type MetricName = 'selfheal_interactions' | 'selfheal_heal_confidence';

export interface MetricPoint {
  /** Prometheus-style name; exporters may adapt it (Datadog uses dots). */
  name: MetricName;
  labels: Record<string, string>;
  value: number;
}

export interface ITelemetryExporter {
  export(outcomes: readonly HealingOutcome[]): Promise<void>;
}

/** Every exported metric is a gauge describing the outcomes passed in. */
export const METRIC_HELP: Record<MetricName, string> = {
  selfheal_interactions: 'Interactions in the exported heal reports, by outcome strategy.',
  selfheal_heal_confidence:
    'Lowest confidence per element and strategy among non-exact outcomes (the weakest heal).',
};

export function toMetricPoints(outcomes: readonly HealingOutcome[]): MetricPoint[] {
  const interactions: MetricPoint[] = (['exact', 'healed', 'failed'] as const).map(strategy => ({
    name: 'selfheal_interactions',
    labels: { strategy },
    value: outcomes.filter(o => o.strategy === strategy).length,
  }));

  const weakest = new Map<string, MetricPoint>();
  for (const o of outcomes) {
    if (o.strategy === 'exact') continue;
    const key = `${o.logicalName}\u0000${o.strategy}`;
    const seen = weakest.get(key);
    if (!seen || o.confidence < seen.value) {
      weakest.set(key, {
        name: 'selfheal_heal_confidence',
        labels: { logical_name: o.logicalName, strategy: o.strategy },
        value: o.confidence,
      });
    }
  }
  const confidences = [...weakest.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, point]) => point);

  return [...interactions, ...confidences];
}
