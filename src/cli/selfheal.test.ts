/**
 * @file selfheal.test.ts
 * @description Drives the CLI's exported `main()` against temporary heal
 *              reports whose replay artifacts come from real engine output.
 *              Network calls go through a stubbed `fetch`.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { main } from './selfheal';
import { SelfHealingEngine, toLocatorString } from '../healing/SelfHealingEngine';
import { ElementMetaData, HealingOutcome } from '../storage/ElementMetaData';

const DOM = `<div class="actions"><button id="go" class="btn">Pay</button><button id="back" class="btn">Back</button></div>`;
const META: ElementMetaData = {
  logicalName: 'checkout.pay',
  primarySelector: '#old-pay',
  tagName: 'button',
  classes: ['btn'],
  textContent: 'Pay',
  attributes: { class: 'btn' },
  anchorContext: { siblingTexts: ['Back'] },
  capturedAt: '2024-01-01T00:00:00.000Z',
};

let dir: string;
let report: string;
let semanticReport: string;
let healedConfidence: number;

const writeReport = (name: string, outcomes: HealingOutcome[]): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: 'now', outcomes }));
  return file;
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfheal-cli-'));
  const result = await new SelfHealingEngine().heal(DOM, META);
  healedConfidence = result.confidence;
  const base = { durationMs: 1, timestamp: '2024-01-01T00:00:00.000Z' };
  const exact: HealingOutcome = { ...base, logicalName: 'checkout.email', originalSelector: '#email', healedSelector: '#email', confidence: 1, strategy: 'exact' };
  const healed: HealingOutcome = {
    ...base,
    logicalName: META.logicalName,
    originalSelector: META.primarySelector,
    healedSelector: toLocatorString(result.candidate!),
    confidence: result.confidence,
    strategy: 'healed',
    replay: { meta: META, dom: DOM, engineSelector: toLocatorString(result.candidate!) },
  };
  report = writeReport('heal-1.json', [exact, healed]);
  // Embedding-assisted pick that lexical replay cannot reproduce.
  semanticReport = writeReport('heal-semantic.json', [
    { ...healed, replay: { ...healed.replay!, engineSelector: '#back', embeddings: true } },
  ]);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a report');
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const run = async (...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, l => out.push(l), l => err.push(l));
  return { code, out: out.join('\n'), err: err.join('\n') };
};

describe('selfheal replay', () => {
  it('reports unchanged decisions with exit 0 and shows the breakdown', async () => {
    const { code, out } = await run('replay', report);
    expect(code).toBe(0);
    expect(out).toContain('same     checkout.pay');
    expect(out).toContain(`HEALED ${healedConfidence.toFixed(3)} -> #go`);
    expect(out).toMatch(/1\. \d\.\d{3} {2}#go {2}text=1\.00/);
    expect(out).toContain('1 heal attempt(s) replayed, 0 changed.');
  });

  it('flags a decision that a stricter threshold would change, with exit 1', async () => {
    const { code, out } = await run('replay', report, '--threshold', '0.99');
    expect(code).toBe(1);
    expect(out).toContain('CHANGED  checkout.pay');
    expect(out).toContain('replayed : NOT HEALED');
  });

  it('accepts custom weights and --top', async () => {
    const { code, out } = await run('replay', report, '--weights', '{"text":0.9,"anchor":0.05}', '--top', '1');
    expect(code).toBe(0);
    expect(out).not.toMatch(/ {5}2\. /);
  });

  it('labels embedding-assisted decisions as semantic instead of failing', async () => {
    const { code, out } = await run('replay', semanticReport);
    expect(code).toBe(0);
    expect(out).toContain('semantic  checkout.pay');
    expect(out).toContain('not reproducible by lexical replay');
  });

  it('expands a directory to its *.json reports', async () => {
    const { code, out } = await run('replay', dir);
    expect(code).toBe(0);
    expect(out).toContain('2 heal attempt(s) replayed, 0 changed.');
  });
});

describe('selfheal export', () => {
  it('prints Prometheus text on a dry run, without any page content', async () => {
    const { code, out } = await run('export', report);
    expect(code).toBe(0);
    expect(out).toContain('selfheal_interactions{strategy="healed"} 1');
    expect(out).toContain(`selfheal_heal_confidence{logical_name="checkout.pay",strategy="healed"} ${healedConfidence}`);
    expect(out).not.toContain('Back');
  });

  it('writes a textfile for node_exporter', async () => {
    const file = path.join(dir, 'out', 'selfheal.prom');
    const { code, out } = await run('export', report, '--prometheus-file', file);
    expect(code).toBe(0);
    expect(out).toContain('Exported 2 outcome(s)');
    expect(fs.readFileSync(file, 'utf-8')).toContain('selfheal_interactions{strategy="exact"} 1');
  });

  it('pushes to a Pushgateway, and exits 1 when the push is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    expect((await run('export', report, '--pushgateway', 'http://pgw:9091', '--job', 'ci')).code).toBe(0);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const failed = await run('export', report, '--pushgateway', 'http://pgw:9091');
    expect(failed.code).toBe(1);
    expect(failed.err).toContain('HTTP 500 boom');
  });

  it('sends to Datadog with the key from the environment', async () => {
    const fetchMock = vi.fn(async () => new Response('{"errors":[]}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('DD_API_KEY', 'env-key');
    vi.stubEnv('DD_SITE', 'us5.datadoghq.com');
    const { code, out } = await run('export', report, '--datadog');
    expect(code).toBe(0);
    expect(out).toContain('Datadog (us5.datadoghq.com)');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.us5.datadoghq.com/api/v2/series');
    expect(init.headers).toMatchObject({ 'DD-API-KEY': 'env-key' });
  });
});

describe('selfheal usage errors (exit 2)', () => {
  it.each([
    ['no command', []],
    ['an unknown command', ['nope']],
    ['no report given', ['replay']],
    ['a missing file', ['replay', 'does-not-exist.json']],
    ['a threshold out of range', ['replay', '__REPORT__', '--threshold', '2']],
    ['a non-integer --top', ['replay', '__REPORT__', '--top', '2.5']],
    ['weights that are not JSON', ['replay', '__REPORT__', '--weights', 'text=1']],
    ['an unknown weight', ['replay', '__REPORT__', '--weights', '{"txt":1}']],
    ['a negative weight', ['replay', '__REPORT__', '--weights', '{"text":-1}']],
    ['an unknown flag', ['replay', '__REPORT__', '--bogus']],
    ['an export flag on replay', ['replay', '__REPORT__', '--datadog']],
    ['a replay flag on export', ['export', '__REPORT__', '--threshold', '0.5']],
    ['--job without --pushgateway', ['export', '__REPORT__', '--job', 'x']],
    ['a non-http pushgateway', ['export', '__REPORT__', '--pushgateway', 'ftp://pgw']],
    ['Datadog without DD_API_KEY', ['export', '__REPORT__', '--datadog']],
  ])('rejects %s', async (_label, argv) => {
    vi.stubEnv('DD_API_KEY', '');
    const { code, err } = await run(...argv.map(a => (a === '__REPORT__' ? report : a)));
    expect(code).toBe(2);
    expect(err).toMatch(/^selfheal: /);
  });

  it('rejects a JSON file that is not a heal report', async () => {
    const bogus = path.join(dir, 'bogus.txt');
    fs.writeFileSync(bogus, '{"nope":true}');
    const { code, err } = await run('replay', bogus);
    expect(code).toBe(2);
    expect(err).toContain('not a heal report');
  });

  it('prints usage with exit 0 for --help', async () => {
    const { code, out } = await run('--help');
    expect(code).toBe(0);
    expect(out).toContain('selfheal replay');
    expect(out).toContain('selfheal export');
  });
});
