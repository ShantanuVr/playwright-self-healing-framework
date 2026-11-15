/**
 * @file exporters.test.ts
 * @description Telemetry derivation and both exporters' wire formats.
 *              `fetch` is stubbed and files go to a temp dir – no network.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ElementMetaData, HealingOutcome } from '../storage/ElementMetaData';
import { toMetricPoints } from './ITelemetryExporter';
import { PrometheusExporter } from './PrometheusExporter';
import { DatadogExporter } from './DatadogExporter';

const outcome = (logicalName: string, strategy: HealingOutcome['strategy'], confidence: number): HealingOutcome => ({
  logicalName,
  originalSelector: '#old',
  strategy,
  confidence,
  durationMs: 1,
  timestamp: '2024-01-01T00:00:00.000Z',
  // Page HTML that must never reach any exporter.
  replay: { meta: {} as ElementMetaData, dom: '<p>secret</p>' },
});

const OUTCOMES: HealingOutcome[] = [
  outcome('checkout.submit', 'exact', 1),
  outcome('checkout.submit', 'healed', 0.82),
  outcome('checkout.submit', 'healed', 0.66),
  outcome('checkout.email', 'failed', 0.41),
];

const okFetch = (status = 200, body = '') => vi.fn(async () => new Response(body, { status }));

afterEach(() => vi.unstubAllGlobals());

describe('toMetricPoints', () => {
  it('counts every strategy (zeros included) and keeps the weakest non-exact confidence', () => {
    expect(toMetricPoints(OUTCOMES)).toEqual([
      { name: 'selfheal_interactions', labels: { strategy: 'exact' }, value: 1 },
      { name: 'selfheal_interactions', labels: { strategy: 'healed' }, value: 2 },
      { name: 'selfheal_interactions', labels: { strategy: 'failed' }, value: 1 },
      { name: 'selfheal_heal_confidence', labels: { logical_name: 'checkout.email', strategy: 'failed' }, value: 0.41 },
      { name: 'selfheal_heal_confidence', labels: { logical_name: 'checkout.submit', strategy: 'healed' }, value: 0.66 },
    ]);
  });

  it('never uses anything but strategy and logical_name as labels', () => {
    for (const p of toMetricPoints(OUTCOMES)) {
      expect(Object.keys(p.labels).every(k => k === 'strategy' || k === 'logical_name')).toBe(true);
    }
  });
});

describe('PrometheusExporter', () => {
  it('renders valid text exposition: one HELP/TYPE group per metric, no timestamps, LF-terminated', () => {
    expect(new PrometheusExporter().render(OUTCOMES)).toBe(
      [
        '# HELP selfheal_interactions Interactions in the exported heal reports, by outcome strategy.',
        '# TYPE selfheal_interactions gauge',
        'selfheal_interactions{strategy="exact"} 1',
        'selfheal_interactions{strategy="healed"} 2',
        'selfheal_interactions{strategy="failed"} 1',
        '# HELP selfheal_heal_confidence Lowest confidence per element and strategy among non-exact outcomes (the weakest heal).',
        '# TYPE selfheal_heal_confidence gauge',
        'selfheal_heal_confidence{logical_name="checkout.email",strategy="failed"} 0.41',
        'selfheal_heal_confidence{logical_name="checkout.submit",strategy="healed"} 0.66',
        '',
      ].join('\n'),
    );
  });

  it('escapes backslash, double quote and line feed in label values', () => {
    const text = new PrometheusExporter().render([outcome('a\\b"c\nd', 'healed', 0.7)]);
    expect(text).toContain('logical_name="a\\\\b\\"c\\nd"');
  });

  it('omits a metric with no samples instead of emitting an empty group', () => {
    const text = new PrometheusExporter().render([outcome('x', 'exact', 1)]);
    expect(text).not.toContain('selfheal_heal_confidence');
  });

  it('PUTs to /metrics/job@base64/<job> with the text content type', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    await new PrometheusExporter({ pushgatewayUrl: 'http://pgw:9091/', job: 'checkout/e2e' }).export(OUTCOMES);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://pgw:9091/metrics/job@base64/${Buffer.from('checkout/e2e').toString('base64url')}`);
    expect(init.method).toBe('PUT');
    expect(init.headers).toMatchObject({ 'Content-Type': 'text/plain; version=0.0.4' });
    expect(init.body).toBe(new PrometheusExporter().render(OUTCOMES));
    expect(String(init.body)).not.toContain('secret');
  });

  it('reports a rejected push with status and body', async () => {
    vi.stubGlobal('fetch', okFetch(400, 'duplicate metric'));
    await expect(new PrometheusExporter({ pushgatewayUrl: 'http://pgw:9091' }).export(OUTCOMES)).rejects.toThrow(/HTTP 400 duplicate metric/);
  });

  it('writes the textfile atomically (no temp file left behind)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfheal-prom-'));
    try {
      const filePath = path.join(dir, 'sub', 'selfheal.prom');
      await new PrometheusExporter({ filePath }).export(OUTCOMES);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe(new PrometheusExporter().render(OUTCOMES));
      expect(fs.readdirSync(path.dirname(filePath))).toEqual(['selfheal.prom']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an empty job name', () => {
    expect(() => new PrometheusExporter({ job: '  ' })).toThrow(/job/);
  });
});

describe('DatadogExporter', () => {
  const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);

  it('builds v2 series: dotted names, gauge type 3, export-time timestamp in seconds, key:value tags', () => {
    const { series } = new DatadogExporter({ apiKey: 'k' }).payload(OUTCOMES, NOW);
    expect(series).toHaveLength(5);
    expect(series[1]).toEqual({
      metric: 'selfheal.interactions',
      type: 3,
      points: [{ timestamp: NOW / 1000, value: 2 }],
      tags: ['strategy:healed'],
    });
    expect(series[4]).toMatchObject({
      metric: 'selfheal.heal.confidence',
      tags: ['logical_name:checkout.submit', 'strategy:healed'],
    });
  });

  it('POSTs to the site\'s series endpoint with the API key header', async () => {
    const fetchMock = okFetch(202, '{"errors":[]}');
    vi.stubGlobal('fetch', fetchMock);
    await new DatadogExporter({ apiKey: 'dd-key', site: 'datadoghq.eu' }).export(OUTCOMES);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.datadoghq.eu/api/v2/series');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'DD-API-KEY': 'dd-key', 'Content-Type': 'application/json' });
    expect(String(init.body)).not.toContain('secret');
  });

  it('reports a rejected submission with status and body', async () => {
    vi.stubGlobal('fetch', okFetch(403, '{"errors":["Forbidden"]}'));
    await expect(new DatadogExporter({ apiKey: 'bad' }).export(OUTCOMES)).rejects.toThrow(/HTTP 403.*Forbidden/);
  });

  it('requires an API key and only accepts Datadog sites', () => {
    expect(() => new DatadogExporter({ apiKey: '' })).toThrow(/API key/);
    expect(() => new DatadogExporter({ apiKey: 'k', site: 'evil.example.com' })).toThrow(/not a Datadog site/);
    expect(() => new DatadogExporter({ apiKey: 'k', site: 'datadoghq.com.evil.io' })).toThrow(/not a Datadog site/);
    for (const site of ['datadoghq.com', 'us5.datadoghq.com', 'datadoghq.eu', 'ap1.datadoghq.com', 'ddog-gov.com']) {
      expect(() => new DatadogExporter({ apiKey: 'k', site })).not.toThrow();
    }
  });
});
