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
 *
 * Exit codes: 0 = nothing changed, 1 = a decision changed (or the engine
 * failed on a recorded DOM), 2 = bad arguments or unreadable reports.
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

type Print = (line: string) => void;

const USAGE = `Usage:
  selfheal replay <report.json|dir>... [--threshold N] [--weights JSON] [--top N]`;

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

function replay(
  inputs: string[],
  engine: SelfHealingEngine,
  out: Print,
): number {
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
        result = engine.heal(rec.dom, rec.meta);
      } catch (err) {
        changed++;
        out(`ERROR    ${where}: ${(err as Error).message}`);
        continue;
      }
      const replayed = result.healed && result.candidate ? toLocatorString(result.candidate) : undefined;
      const same = replayed === rec.engineSelector;
      if (!same) changed++;

      out(`${same ? 'same   ' : 'CHANGED'}  ${where}`);
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
        help: { type: 'boolean', short: 'h' },
      },
    });
    const [command, ...inputs] = positionals;
    if (values.help) {
      out(USAGE);
      return 0;
    }
    if (command !== 'replay') {
      throw new Error(command ? `unknown command "${command}"` : 'missing command');
    }
    if (inputs.length === 0) throw new Error('replay needs at least one report file or directory');

    const engine = new SelfHealingEngine({
      threshold: parseNumber('threshold', values.threshold, 0, 1),
      weights: parseWeights(values.weights),
      topN: parseNumber('top', values.top, 0, 50, true),
    });
    return replay(inputs, engine, out);
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
