#!/usr/bin/env node
/**
 * @file selfheal.ts
 * @description Command-line companion for the heal reports written by
 *              {@link StateReporter} (`reports/*.json`).
 *
 *   replay <report|dir>...   Re-run the engine, offline and without a
 *                            browser, on every recorded heal attempt and
 *                            flag decisions that would change – e.g. after
 *                            tuning weights or the threshold.
 *   export <report|dir>...   Turn the outcomes into confidence telemetry for
 *                            Grafana (Prometheus) and/or Datadog.
 *
 * Exit codes – replay: 0 = nothing changed, 1 = a decision changed (or the
 * engine failed on a recorded DOM); export: 0 = exported, 1 = an export
 * failed; both: 2 = bad arguments or unreadable reports.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';
import {
  SelfHealingEngine,
  HealingWeights,
  HealResult,
  toLocatorString,
} from '../healing/SelfHealingEngine';
import { HealingOutcome } from '../storage/ElementMetaData';
import { ITelemetryExporter } from '../telemetry/ITelemetryExporter';
import { PrometheusExporter } from '../telemetry/PrometheusExporter';
import { DatadogExporter } from '../telemetry/DatadogExporter';

type Print = (line: string) => void;

const USAGE = `Usage:
  selfheal replay <report.json|dir>... [--threshold N] [--weights JSON] [--top N]
  selfheal export <report.json|dir>... [--prometheus-file PATH] [--pushgateway URL] [--job NAME] [--datadog]

  export with no target prints Prometheus text to stdout.
  --datadog reads DD_API_KEY (required) and DD_SITE (default datadoghq.com) from the environment.`;

const COMMAND_FLAGS: Record<'replay' | 'export', string[]> = {
  replay: ['threshold', 'weights', 'top'],
  export: ['prometheus-file', 'pushgateway', 'job', 'datadog'],
};

const SIGNALS: Array<keyof HealingWeights> = ['text', 'tag', 'id', 'classes', 'attributes', 'anchor'];

interface LoadedReport {
  file: string;
  outcomes: HealingOutcome[];
}

/** Reads report files, expanding directories to the `*.json` files inside. */
export function loadReports(inputs: string[]): LoadedReport[] {
  const files = inputs.flatMap(input =>
    fs.statSync(input).isDirectory()
      ? fs.readdirSync(input).filter(f => f.endsWith('.json')).sort().map(f => path.join(input, f))
      : [input],
  );
  return files.map(file => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      throw new Error(`${file}: not valid JSON (${(err as Error).message})`);
    }
    const outcomes = (parsed as { outcomes?: unknown } | null)?.outcomes;
    if (!Array.isArray(outcomes)) {
      throw new Error(`${file}: not a heal report (no "outcomes" array)`);
    }
    return { file, outcomes: outcomes as HealingOutcome[] };
  });
}

function parseNumber(
  name: string,
  raw: string | undefined,
  min: number,
  max: number,
  integer = false,
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`--${name} must be ${integer ? 'an integer' : 'a number'} in [${min}, ${max}], got "${raw}"`);
  }
  return value;
}

function parseWeights(raw: string | undefined): Partial<HealingWeights> | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--weights must be a JSON object, e.g. '{"text":0.4,"anchor":0.25}'`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--weights must be a JSON object');
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!SIGNALS.includes(key as keyof HealingWeights)) {
      throw new Error(`--weights: unknown signal "${key}" (expected ${SIGNALS.join(', ')})`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`--weights: "${key}" must be a non-negative number`);
    }
  }
  return parsed as Partial<HealingWeights>;
}

const decision = (selector: string | undefined, confidence: number): string =>
  selector
    ? `HEALED ${confidence.toFixed(3)} -> ${selector}`
    : `NOT HEALED (best ${confidence.toFixed(3)})`;

async function replay(
  inputs: string[],
  engine: SelfHealingEngine,
  out: Print,
): Promise<number> {
  let attempts = 0;
  let changed = 0;
  for (const { file, outcomes } of loadReports(inputs)) {
    for (const outcome of outcomes) {
      const rec = outcome.replay;
      if (!rec) continue;
      attempts++;
      const where = `${outcome.logicalName}  (${path.basename(file)})`;

      let result: HealResult;
      try {
        result = await engine.heal(rec.dom, rec.meta);
      } catch (err) {
        changed++;
        out(`ERROR    ${where}: ${(err as Error).message}`);
        continue;
      }
      const replayed = result.healed && result.candidate ? toLocatorString(result.candidate) : undefined;
      const same = replayed === rec.engineSelector;
      // An embedding-assisted decision can't be reproduced lexically, so a
      // difference there is expected and doesn't fail the run.
      if (!same && !rec.embeddings) changed++;

      const status = rec.embeddings ? 'semantic' : same ? 'same   ' : 'CHANGED';
      const note = rec.embeddings ? '  [semantic: not reproducible by lexical replay]' : '';
      out(`${status}  ${where}${note}`);
      out(`   recorded : ${decision(rec.engineSelector, outcome.confidence)}`);
      out(`   replayed : ${decision(replayed, result.confidence)}`);
      result.topCandidates.forEach((c, i) => {
        const breakdown = SIGNALS.map(s => `${s}=${c.breakdown[s].toFixed(2)}`).join(' ');
        out(`     ${i + 1}. ${c.score.toFixed(3)}  ${toLocatorString(c)}  ${breakdown}`);
      });
    }
  }
  out(
    attempts === 0
      ? 'No replayable heal attempts found (nothing needed healing, or the reports predate replay support).'
      : `\n${attempts} heal attempt(s) replayed, ${changed} changed.`,
  );
  return changed > 0 ? 1 : 0;
}

function parseHttpUrl(name: string, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`--${name} must be an http(s) URL, got "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`--${name} must be an http(s) URL, got "${raw}"`);
  }
  return raw;
}

/** Runs every exporter; a failing target is reported but does not stop the others. */
async function runExports(
  targets: Array<{ label: string; exporter: ITelemetryExporter }>,
  outcomes: HealingOutcome[],
  out: Print,
  err: Print,
): Promise<number> {
  let failed = 0;
  for (const { label, exporter } of targets) {
    try {
      await exporter.export(outcomes);
      out(`Exported ${outcomes.length} outcome(s) to ${label}.`);
    } catch (e) {
      failed++;
      err(`selfheal: export to ${label} failed: ${(e as Error).message}`);
    }
  }
  return failed > 0 ? 1 : 0;
}

export async function main(
  argv: string[],
  out: Print = console.log,
  err: Print = console.error,
): Promise<number> {
  try {
    const { positionals, values } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        threshold: { type: 'string' },
        weights: { type: 'string' },
        top: { type: 'string' },
        'prometheus-file': { type: 'string' },
        pushgateway: { type: 'string' },
        job: { type: 'string' },
        datadog: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    const [command, ...inputs] = positionals;
    if (values.help) {
      out(USAGE);
      return 0;
    }
    if (command !== 'replay' && command !== 'export') {
      throw new Error(command ? `unknown command "${command}"` : 'missing command');
    }
    const stray = Object.keys(values).find(k => k !== 'help' && !COMMAND_FLAGS[command].includes(k));
    if (stray) throw new Error(`--${stray} is not an option of "${command}"`);
    if (inputs.length === 0) throw new Error(`${command} needs at least one report file or directory`);

    if (command === 'replay') {
      const engine = new SelfHealingEngine({
        threshold: parseNumber('threshold', values.threshold, 0, 1),
        weights: parseWeights(values.weights),
        topN: parseNumber('top', values.top, 0, 50, true),
      });
      // `await` so a rejection (e.g. unreadable report) lands in the catch → exit 2.
      return await replay(inputs, engine, out);
    }

    const outcomes = loadReports(inputs).flatMap(r => r.outcomes);
    const targets: Array<{ label: string; exporter: ITelemetryExporter }> = [];
    const pushgatewayUrl = parseHttpUrl('pushgateway', values.pushgateway);
    const filePath = values['prometheus-file'];
    if (values.job !== undefined && !pushgatewayUrl) {
      throw new Error('--job only applies with --pushgateway');
    }
    if (filePath || pushgatewayUrl) {
      targets.push({
        label: [filePath, pushgatewayUrl].filter(Boolean).join(' + '),
        exporter: new PrometheusExporter({ filePath, pushgatewayUrl, job: values.job }),
      });
    }
    if (values.datadog) {
      const site = process.env.DD_SITE || undefined;
      targets.push({
        label: `Datadog (${site ?? 'datadoghq.com'})`,
        exporter: new DatadogExporter({ apiKey: process.env.DD_API_KEY ?? '', site }),
      });
    }
    if (targets.length === 0) {
      out(new PrometheusExporter().render(outcomes).trimEnd());
      return 0;
    }
    return await runExports(targets, outcomes, out, err);
  } catch (e) {
    err(`selfheal: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
}

if (require.main === module) {
  void main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
