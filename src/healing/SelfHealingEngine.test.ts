/**
 * @file SelfHealingEngine.test.ts
 * @description Unit tests for the self-healing engine. These tests run
 *              entirely in-memory against handcrafted HTML fixtures, so
 *              they execute in < 500 ms and do not require a browser.
 */

import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { SelfHealingEngine, toLocatorString } from './SelfHealingEngine';
import { IEmbeddingProvider } from './IEmbeddingProvider';
import { ElementMetaData } from '../storage/ElementMetaData';

const metaFromOriginal = (): ElementMetaData => ({
  logicalName: 'submitButton',
  primarySelector: '[data-testid="checkout-submit"]',
  tagName: 'button',
  id: 'submit-order',
  classes: ['submit-btn', 'primary-action'],
  textContent: 'Submit Order',
  attributes: {
    id: 'submit-order',
    class: 'submit-btn primary-action',
    'data-testid': 'checkout-submit',
    type: 'button',
  },
  anchorContext: {
    parentTag: 'div',
    parentText: '',
    siblingTexts: ['Cancel'],
    dataTestId: 'checkout-submit',
    labelText: '',
  },
  capturedAt: '2024-01-01T00:00:00.000Z',
});

const ORIGINAL_DOM = `
  <html><body><div class="actions">
    <button id="submit-order" class="submit-btn primary-action" data-testid="checkout-submit" type="button">Submit Order</button>
    <button id="cancel-order" class="cancel-btn" type="button">Cancel</button>
  </div></body></html>
`;

const MUTATED_DOM = `
  <html><body><div class="actions">
    <button id="btn_a1b2c3d4" class="cta-btn primary-cta" type="button">Submit Order</button>
    <button id="btn_cancel_x" class="secondary-btn" type="button">Cancel</button>
  </div></body></html>
`;

const UNRELATED_DOM = `
  <html><body>
    <h1>404 - Page Not Found</h1>
    <p>Nothing to see here.</p>
  </body></html>
`;

describe('SelfHealingEngine.heal – happy path', () => {
  it('returns confidence 1 and the same node when the DOM is unchanged', async () => {
    const engine = new SelfHealingEngine();
    const result = await engine.heal(ORIGINAL_DOM, metaFromOriginal());

    expect(result.healed).toBe(true);
    expect(result.confidence).toBeCloseTo(1, 2);
    expect(result.candidate?.textContent).toBe('Submit Order');
  });

  it('heals through a full id/class mutation while preserving semantics', async () => {
    const engine = new SelfHealingEngine();
    const result = await engine.heal(MUTATED_DOM, metaFromOriginal());

    expect(result.healed).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.candidate?.textContent).toBe('Submit Order');
    // The Submit candidate must outrank the Cancel sibling.
    const ranked = result.topCandidates.map(c => c.textContent);
    expect(ranked[0]).toBe('Submit Order');
    expect(ranked.indexOf('Cancel')).toBeGreaterThan(0);
  });

  it('prefers a stable CSS strategy (id over class) in the healed selector', async () => {
    const engine = new SelfHealingEngine();
    const result = await engine.heal(MUTATED_DOM, metaFromOriginal());
    // The mutated node has id=btn_a1b2c3d4 and no data-testid → selector
    // should be the id form.
    expect(result.selector).toBe('#btn_a1b2c3d4');
  });

  it('emits a well-formed XPath on every candidate', async () => {
    const engine = new SelfHealingEngine();
    const result = await engine.heal(MUTATED_DOM, metaFromOriginal());
    expect(result.candidate?.xpath).toBeDefined();
    expect(result.candidate!.xpath.startsWith('//')).toBe(true);
    result.topCandidates.forEach(c =>
      expect(typeof c.xpath).toBe('string'),
    );
  });
});

describe('SelfHealingEngine.heal – guardrails', () => {
  it('refuses to heal when no candidate meets the threshold', async () => {
    const engine = new SelfHealingEngine();
    const result = await engine.heal(UNRELATED_DOM, metaFromOriginal());

    expect(result.healed).toBe(false);
    expect(result.selector).toBeUndefined();
    expect(result.confidence).toBeLessThan(0.6);
  });

  it('honours an elevated threshold and declines marginal heals', async () => {
    const strict = new SelfHealingEngine({ threshold: 0.95 });
    const result = await strict.heal(MUTATED_DOM, metaFromOriginal());
    expect(result.healed).toBe(false);
    // But the engine still reports what it considered, so the StateReporter
    // has material to explain the failure.
    expect(result.topCandidates.length).toBeGreaterThan(0);
  });

  it('falls back to scanning all elements when the captured tag is absent', async () => {
    const engine = new SelfHealingEngine();
    const domWithoutButtons = `
      <html><body><div class="actions">
        <a id="submit-order" class="submit-btn" data-testid="checkout-submit">Submit Order</a>
      </div></body></html>
    `;
    const result = await engine.heal(domWithoutButtons, metaFromOriginal());
    // Tag mismatch should not prevent a heal if other signals are strong.
    expect(result.candidatesEvaluated).toBeGreaterThan(0);
    expect(result.candidate?.textContent).toBe('Submit Order');
  });

  it('keeps confidence within [0, 1]', async () => {
    const engine = new SelfHealingEngine();
    const result = await engine.heal(MUTATED_DOM, metaFromOriginal());
    result.topCandidates.forEach(c => {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(1);
    });
  });

  it('limits topCandidates to the configured topN', async () => {
    const engine = new SelfHealingEngine({ topN: 2 });
    const result = await engine.heal(MUTATED_DOM, metaFromOriginal());
    expect(result.topCandidates.length).toBeLessThanOrEqual(2);
  });
});

describe('SelfHealingEngine.heal – selector strategy precedence', () => {
  const baseMeta = (): ElementMetaData => ({
    logicalName: 'el',
    primarySelector: 'x',
    tagName: 'button',
    classes: [],
    textContent: 'Click me',
    attributes: {},
    anchorContext: { siblingTexts: [] },
    capturedAt: '2024-01-01T00:00:00.000Z',
  });

  it('prefers data-testid over everything else', async () => {
    const engine = new SelfHealingEngine();
    const dom = `<button data-testid="go" id="some-id" class="a b">Click me</button>`;
    const result = await engine.heal(dom, baseMeta());
    expect(result.candidate?.selector).toBe('[data-testid="go"]');
    expect(result.candidate?.xpath).toBe("//*[@data-testid='go']");
  });

  it('falls back to id when no data-testid is present', async () => {
    const engine = new SelfHealingEngine();
    const dom = `<button id="go-btn" class="a b">Click me</button>`;
    const result = await engine.heal(dom, baseMeta());
    expect(result.candidate?.selector).toBe('#go-btn');
    expect(result.candidate?.xpath).toBe("//*[@id='go-btn']");
  });

  it('uses visible text for XPath when only class is available', async () => {
    const engine = new SelfHealingEngine();
    const dom = `<button class="x y">Click me</button>`;
    const result = await engine.heal(dom, baseMeta());
    expect(result.candidate?.selector).toBe('button.x.y');
    expect(result.candidate?.xpath).toBe("//button[normalize-space()='Click me']");
  });

  it('uses contains(@class) for XPath on non-text tags', async () => {
    const engine = new SelfHealingEngine();
    const meta = { ...baseMeta(), tagName: 'input', textContent: '' };
    const dom = `<input class="x y"/>`;
    const result = await engine.heal(dom, meta);
    expect(result.candidate?.selector).toBe('input.x.y');
    expect(result.candidate?.xpath).toContain("contains(concat(' ', normalize-space(@class), ' '), ' x ')");
  });
});

describe('SelfHealingEngine.heal – custom weights', () => {
  it('respects injected weights (heavier anchor => higher score for context-heavy match)', async () => {
    const defaultEngine = new SelfHealingEngine();
    const contextEngine = new SelfHealingEngine({
      weights: { text: 0.20, tag: 0.10, id: 0.05, classes: 0.10, attributes: 0.10, anchor: 0.45 },
    });

    // A slight text drift so the two engines score differently.
    const meta = metaFromOriginal();
    meta.textContent = 'Place Order';

    const defaultResult = await defaultEngine.heal(MUTATED_DOM, meta);
    const contextResult = await contextEngine.heal(MUTATED_DOM, meta);

    expect(contextResult.confidence).toBeGreaterThan(defaultResult.confidence);
  });
});

const bareMeta = (over: Partial<ElementMetaData> = {}): ElementMetaData => ({
  logicalName: 'el',
  primarySelector: '#gone',
  tagName: 'button',
  classes: ['btn'],
  textContent: 'Pay',
  attributes: { class: 'btn' },
  anchorContext: { siblingTexts: [] },
  capturedAt: '2024-01-01T00:00:00.000Z',
  ...over,
});

describe('SelfHealingEngine.heal – healed selectors point at the scored node', () => {
  it('uses the first strategy that is unique in the DOM', async () => {
    // Both buttons share the class; only the target has a unique `name`.
    const dom = `<button class="btn" name="pay">Pay</button><button class="btn">Pay</button>`;
    const result = await new SelfHealingEngine().heal(dom, bareMeta({ attributes: { class: 'btn', name: 'pay' } }));
    expect(result.candidate?.selector).toBe('button[name="pay"]');
    expect(result.candidate?.nth).toBe(0);
  });

  it('adds the node index when no strategy is unique (look-alike twins)', async () => {
    const dom = `
      <div><span>Light total</span><button class="btn">Pay</button></div>
      <div><span>Dark total</span><button class="btn">Pay</button></div>`;
    const result = await new SelfHealingEngine().heal(dom, bareMeta({ anchorContext: { siblingTexts: ['Dark total'] } }));
    expect(result.candidate).toMatchObject({ selector: 'button.btn', nth: 1 });
    expect(toLocatorString(result.candidate!)).toBe('button.btn >> nth=1');
  });

  it('escapes ids that start with a digit into valid CSS', async () => {
    const dom = `<button id="1abc" class="btn">Pay</button><button class="btn">Back</button>`;
    const result = await new SelfHealingEngine().heal(dom, bareMeta());
    expect(result.candidate?.selector).toBe('#\\31 abc');
    expect(cheerio.load(dom)(result.candidate!.selector).length).toBe(1);
  });

  it('copes with quotes in ids during the label[for] lookup', async () => {
    const dom = `<label for='mail"x'>Email</label><input id='mail"x' type="email">`;
    const meta = bareMeta({ tagName: 'input', textContent: '', classes: [], attributes: { type: 'email' }, anchorContext: { siblingTexts: ['Email'], labelText: 'Email' } });
    const result = await new SelfHealingEngine().heal(dom, meta);
    expect(result.healed).toBe(true);
    // A perfect anchor proves the label was found (without it: 0.6).
    expect(result.candidate?.breakdown.anchor).toBe(1);
  });

  it('handles namespaced tag names that are not valid CSS as-is', async () => {
    const dom = `<x:btn class="a">Pay</x:btn><x:btn class="b">Back</x:btn>`;
    const result = await new SelfHealingEngine().heal(dom, bareMeta({ tagName: 'x:btn', classes: ['a'], attributes: { class: 'a' } }));
    expect(result.candidate?.selector).toBe('x\\:btn.a');
    expect(cheerio.load(dom)(result.candidate!.selector).length).toBe(1);
  });
});

describe('SelfHealingEngine.heal – relaxed scan', () => {
  it('heals a re-tagged element even when other same-tag nodes remain', async () => {
    const dom = `<div class="actions"><a id="submit-order" class="submit-btn" data-testid="checkout-submit">Submit Order</a><button id="cancel-order" class="cancel-btn">Cancel</button></div>`;
    const result = await new SelfHealingEngine().heal(dom, metaFromOriginal());
    expect(result.healed).toBe(true);
    expect(result.candidate?.tagName).toBe('a');
  });

  it('breaks score ties toward the innermost node', async () => {
    // Wrapper and child carry identical signals; the child is the real target.
    const dom = `<div><span>Submit Order</span></div>`;
    const result = await new SelfHealingEngine().heal(dom, bareMeta({ tagName: 'a', textContent: 'Submit Order', classes: [], attributes: {} }));
    const [first, second] = result.topCandidates;
    expect(first.score).toBe(second.score);
    expect(first.tagName).toBe('span');
  });
});

describe('SelfHealingEngine.heal – optional embeddings', () => {
  // "Submit Order" and "Buy now" mean the same thing; "Cancel" does not.
  const CONCEPTS: Record<string, number[]> = { 'Submit Order': [1, 0, 0], 'Buy now': [0.96, 0.1, 0.05], Cancel: [0, 1, 0] };
  const fakeProvider = (impl?: (texts: string[]) => Promise<number[][]>) => {
    const calls: string[][] = [];
    const provider: IEmbeddingProvider = {
      embed: async texts => {
        calls.push(texts);
        return impl ? impl(texts) : texts.map(t => CONCEPTS[t] ?? [0, 0, 1]);
      },
    };
    return { provider, calls };
  };
  const DRIFT_DOM = `<div class="actions"><button id="x1" class="btn">Buy now</button><button id="x2" class="btn">Cancel</button></div>`;

  it('rescues a semantic rewrite that lexical scoring rejects', async () => {
    const lexical = await new SelfHealingEngine().heal(DRIFT_DOM, metaFromOriginal());
    expect(lexical.healed).toBe(false);

    const { provider, calls } = fakeProvider();
    const semantic = await new SelfHealingEngine({ embeddings: { provider, weight: 0.8 } }).heal(DRIFT_DOM, metaFromOriginal());
    expect(semantic.healed).toBe(true);
    expect(semantic.embeddingsUsed).toBe(true);
    expect(semantic.candidate?.textContent).toBe('Buy now');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('Submit Order');
    expect(new Set(calls[0]).size).toBe(calls[0].length); // deduplicated
  });

  it('keeps lexical scores and warns when the provider fails', async () => {
    const lexical = await new SelfHealingEngine().heal(DRIFT_DOM, metaFromOriginal());
    const { provider } = fakeProvider(async () => { throw new Error('connection refused'); });
    const result = await new SelfHealingEngine({ embeddings: { provider } }).heal(DRIFT_DOM, metaFromOriginal());
    expect(result.embeddingsUsed).toBe(false);
    expect(result.confidence).toBe(lexical.confidence);
    expect(result.warning).toMatch(/Embedding provider failed.*connection refused/);
  });

  it('rejects malformed vectors without failing the heal', async () => {
    const { provider } = fakeProvider(async texts => texts.map(() => [Number.NaN]));
    const result = await new SelfHealingEngine({ embeddings: { provider } }).heal(DRIFT_DOM, metaFromOriginal());
    expect(result.warning).toMatch(/malformed vectors/);
    expect(result.embeddingsUsed).toBe(false);
  });

  it('never calls the provider for elements without visible text', async () => {
    const { provider, calls } = fakeProvider();
    const meta = bareMeta({ tagName: 'input', textContent: '', classes: [], attributes: {} });
    await new SelfHealingEngine({ embeddings: { provider } }).heal('<input name="q">', meta);
    expect(calls).toHaveLength(0);
  });

  it('leaves scores untouched without a provider', async () => {
    const a = await new SelfHealingEngine().heal(MUTATED_DOM, metaFromOriginal());
    expect(a.embeddingsUsed).toBe(false);
    expect(a.warning).toBeUndefined();
  });

  it('rejects an embedding weight outside [0, 1]', () => {
    const { provider } = fakeProvider();
    expect(() => new SelfHealingEngine({ embeddings: { provider, weight: 1.5 } })).toThrow(/weight/);
    expect(() => new SelfHealingEngine({ embeddings: { provider, weight: Number.NaN } })).toThrow(/weight/);
  });
});
