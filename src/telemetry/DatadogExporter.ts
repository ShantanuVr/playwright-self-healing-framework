/**
 * @file DatadogExporter.ts
 * @description Exports heal telemetry to Datadog through the metrics API v2
 *              (`POST /api/v2/series`) – no Agent required, which suits CI.
 */

import { HealingOutcome } from '../storage/ElementMetaData';
import { ITelemetryExporter, toMetricPoints } from './ITelemetryExporter';

export interface DatadogExporterOptions {
  apiKey: string;
  /** Datadog site, e.g. `datadoghq.com` (default), `datadoghq.eu`, `us5.datadoghq.com`. */
  site?: string;
}

/** Datadog series payload (subset of the v2 schema we emit). */
export interface DatadogSeriesPayload {
  series: Array<{
    metric: string;
    type: 3;
    points: Array<{ timestamp: number; value: number }>;
    tags: string[];
  }>;
}

const SUBMIT_TIMEOUT_MS = 10_000;
// Official Datadog sites only, so a mistyped DD_SITE can never send the key elsewhere.
const DATADOG_SITE = /^([a-z0-9-]+\.)?(datadoghq\.com|datadoghq\.eu|ddog-gov\.com)$/;

export class DatadogExporter implements ITelemetryExporter {
  private readonly apiKey: string;
  private readonly site: string;

  constructor(options: DatadogExporterOptions) {
    if (!options.apiKey) {
      throw new Error('[DatadogExporter] An API key is required (set DD_API_KEY).');
    }
    const site = options.site ?? 'datadoghq.com';
    if (!DATADOG_SITE.test(site)) {
      throw new Error(`[DatadogExporter] "${site}" is not a Datadog site (e.g. datadoghq.com, datadoghq.eu).`);
    }
    this.apiKey = options.apiKey;
    this.site = site;
  }

  /**
   * One gauge (`type: 3`) per point, stamped with the export time: Datadog
   * rejects points more than an hour old, and reports are often older.
   */
  public payload(outcomes: readonly HealingOutcome[], now: number = Date.now()): DatadogSeriesPayload {
    const timestamp = Math.floor(now / 1000);
    return {
      series: toMetricPoints(outcomes).map(p => ({
        metric: p.name.replace(/_/g, '.'),
        type: 3,
        points: [{ timestamp, value: p.value }],
        tags: Object.entries(p.labels).map(([key, value]) => `${key}:${value}`),
      })),
    };
  }

  public async export(outcomes: readonly HealingOutcome[]): Promise<void> {
    const res = await fetch(`https://api.${this.site}/api/v2/series`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'DD-API-KEY': this.apiKey },
      body: JSON.stringify(this.payload(outcomes)),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Datadog submit failed: HTTP ${res.status} ${await res.text()}`);
    }
  }
}
