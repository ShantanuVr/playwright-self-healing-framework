/**
 * @file PrometheusExporter.ts
 * @description Exports heal telemetry in the Prometheus text exposition
 *              format (0.0.4) for Grafana: pushed to a Pushgateway and/or
 *              written to a file for node_exporter's textfile collector.
 */

import * as fs from 'fs';
import * as path from 'path';
import { HealingOutcome } from '../storage/ElementMetaData';
import {
  ITelemetryExporter,
  METRIC_HELP,
  MetricName,
  toMetricPoints,
} from './ITelemetryExporter';

export interface PrometheusExporterOptions {
  /** Pushgateway base URL, e.g. `http://localhost:9091`. */
  pushgatewayUrl?: string;
  /** Pushgateway job (grouping key); each push replaces its group. Default `selfheal`. */
  job?: string;
  /** Also write the exposition here, e.g. for node_exporter's textfile collector. */
  filePath?: string;
}

const PUSH_TIMEOUT_MS = 10_000;

/** Label values escape backslash, double quote and line feed. */
const escapeLabel = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

export class PrometheusExporter implements ITelemetryExporter {
  private readonly options: PrometheusExporterOptions;

  constructor(options: PrometheusExporterOptions = {}) {
    if (options.job !== undefined && options.job.trim() === '') {
      throw new Error('[PrometheusExporter] job must not be empty.');
    }
    this.options = options;
  }

  /**
   * Text exposition: one HELP/TYPE group per metric, no timestamps (the
   * Pushgateway rejects pushed timestamps), every line LF-terminated.
   */
  public render(outcomes: readonly HealingOutcome[]): string {
    const points = toMetricPoints(outcomes);
    const lines: string[] = [];
    for (const name of Object.keys(METRIC_HELP) as MetricName[]) {
      const samples = points.filter(p => p.name === name);
      if (samples.length === 0) continue;
      lines.push(`# HELP ${name} ${METRIC_HELP[name]}`, `# TYPE ${name} gauge`);
      for (const p of samples) {
        const labels = Object.entries(p.labels)
          .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
          .join(',');
        lines.push(`${name}{${labels}} ${p.value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  public async export(outcomes: readonly HealingOutcome[]): Promise<void> {
    const body = this.render(outcomes);
    const { pushgatewayUrl, filePath, job = 'selfheal' } = this.options;

    if (filePath) {
      // Write-then-rename: the textfile collector must never read a partial file.
      await fs.promises.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, body, 'utf-8');
      await fs.promises.rename(tmp, filePath);
    }

    if (pushgatewayUrl) {
      // `job@base64` lets any job name through, including ones with "/".
      const url =
        `${pushgatewayUrl.replace(/\/+$/, '')}/metrics/job@base64/` +
        Buffer.from(job).toString('base64url');
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain; version=0.0.4' },
        body,
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`Pushgateway push failed: HTTP ${res.status} ${await res.text()}`);
      }
    }
  }
}
