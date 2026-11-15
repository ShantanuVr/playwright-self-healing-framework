/**
 * @file SelfHealingEngine.ts
 * @description Heart of the framework. Given a snapshot of the current page
 *              DOM and the last known {@link ElementMetaData} of a target
 *              element, the engine scores every candidate node in the DOM
 *              using a weighted multi-signal heuristic and returns the best
 *              match together with a confidence in [0, 1].
 *
 *              The algorithm is DECOUPLED from Playwright on purpose – it
 *              accepts a raw HTML string and returns a plain selector, so
 *              the same engine can be reused from Puppeteer, Selenium,
 *              Cypress or any other runner without modification (SOLID –
 *              Dependency Inversion & Single Responsibility).
 *
 * @section heuristic DOM-ANALYSIS HEURISTIC (v1)
 *
 * For every DOM node sharing the historical `tagName`, the engine computes
 * six sub-scores in [0, 1] and blends them with the weights below. The
 * weights were tuned empirically so that semantic signals (visible text,
 * associated label, sibling context) outweigh cosmetic ones (raw id or
 * class strings) which are the first to churn between releases.
 *
 *   ┌────────────┬──────┬──────────────────────────────────────────────┐
 *   │ signal     │ w    │ description                                  │
 *   ├────────────┼──────┼──────────────────────────────────────────────┤
 *   │ text       │ 0.45 │ Levenshtein similarity of visible text       │
 *   │ tag        │ 0.10 │ Tag name equality (soft penalty if not)      │
 *   │ id         │ 0.05 │ Levenshtein similarity of id attribute       │
 *   │ classes    │ 0.10 │ Tokenised Jaccard similarity of class list   │
 *   │ attributes │ 0.10 │ Ratio of expected attrs still present/simil. │
 *   │ anchor     │ 0.20 │ Blend of label / aria / testid / siblings    │
 *   └────────────┴──────┴──────────────────────────────────────────────┘
 *
 * The `anchor` sub-score is itself a weighted blend:
 *     labelText (0.40) + parentText (0.20) + aria (0.15)
 *   + dataTestId (0.10) + siblingText (0.15)
 *
 * A candidate is treated as a valid heal iff its final score is ≥ the
 * configured `threshold` (default 0.6). Every score is bounded in [0, 1]
 * so the final total is also in [0, 1].
 *
 * If no same-tag node clears the threshold, the scan is relaxed to every
 * element in `<body>` (the element may have been re-tagged, e.g. `button`
 * → `a`); the tag sub-score penalises the mismatch.
 *
 * Optional (Phase 5): with an {@link IEmbeddingProvider} configured, the
 * text signal becomes a blend of Levenshtein and embedding cosine
 * similarity, so copy rewrites with the same meaning still score well.
 * Without one the engine never touches the network.
 */

import * as cheerio from 'cheerio';
import { ElementMetaData } from '../storage/ElementMetaData';
import { SimilarityUtils } from './SimilarityUtils';
import { IEmbeddingProvider } from './IEmbeddingProvider';

/** Local minimal shape of a cheerio element we rely on. */
type CheerioNode = {
  type?: string;
  name?: string;
  attribs?: Record<string, string>;
};

export interface HealingWeights {
  tag: number;
  text: number;
  id: number;
  classes: number;
  attributes: number;
  anchor: number;
}

export interface AnchorWeights {
  labelText: number;
  parentText: number;
  ariaLabel: number;
  dataTestId: number;
  siblings: number;
}

export interface HealCandidate {
  /** Best-effort CSS selector – the most stable strategy that is unique in
   *  the scanned DOM; if none is unique, the most stable one plus `nth`. */
  selector: string;
  /** Index of this node among `selector`'s matches in document order
   *  (0 when unique). Combine the two with {@link toLocatorString}. */
  nth: number;
  /** Equivalent XPath expression – used by SmartPage as a retry fallback
   *  when the CSS form fails (e.g. CSS can't express text-based matches). */
  xpath: string;
  score: number;
  tagName: string;
  id?: string;
  classes: string[];
  textContent: string;
  /** Per-signal decomposition – indispensable for debugging false heals. */
  breakdown: Record<keyof HealingWeights, number>;
}

export interface HealResult {
  healed: boolean;
  confidence: number;
  /** The winner's CSS selector, runner-agnostic. It may also match
   *  look-alikes: `candidate.nth` says which match is meant, and
   *  {@link toLocatorString} combines the two for Playwright. */
  selector?: string;
  candidate?: HealCandidate;
  candidatesEvaluated: number;
  /** Top-N candidates, included in reports for auditability. */
  topCandidates: HealCandidate[];
  /** True when embedding similarity was blended into the text signal. */
  embeddingsUsed?: boolean;
  /** Set when the embedding provider failed and lexical scores were kept. */
  warning?: string;
}

export interface EmbeddingOptions {
  provider: IEmbeddingProvider;
  /** Share of the text signal taken from embedding similarity, in [0, 1]. Default 0.5. */
  weight?: number;
  /**
   * Cosine at or below which two texts count as unrelated, in [0, 1).
   * Default 0.5. Real models give unrelated short texts a cosine of roughly
   * 0.3–0.6, so raw cosine would lift every wrong candidate; similarity is
   * rescaled as `max(0, (cosine − baseline) / (1 − baseline))`. Lower it
   * for models with low baseline similarity, raise it for high ones.
   */
  baseline?: number;
}

export interface SelfHealingEngineOptions {
  weights?: Partial<HealingWeights>;
  anchorWeights?: Partial<AnchorWeights>;
  /** Minimum score required to accept a candidate (default 0.6). */
  threshold?: number;
  /** Keep top-N candidates in {@link HealResult.topCandidates}. Default 5. */
  topN?: number;
  /** Opt-in semantic text similarity (Phase 5). Off by default. */
  embeddings?: EmbeddingOptions;
}

/**
 * Playwright selector-string form of a candidate: the CSS selector, plus a
 * `>> nth=N` suffix when the selector also matches other nodes.
 */
export function toLocatorString(candidate: Pick<HealCandidate, 'selector' | 'nth'>): string {
  return candidate.nth > 0 ? `${candidate.selector} >> nth=${candidate.nth}` : candidate.selector;
}

/** Internal scoring record – keeps the node so selectors are built lazily. */
interface ScoredNode {
  node: CheerioNode;
  attribs: Record<string, string>;
  depth: number;
  score: number;
  tagName: string;
  id: string;
  classes: string[];
  text: string;
  /** Unrounded sub-scores; rounded only when reported. */
  parts: Record<keyof HealingWeights, number>;
}

/** Highest score first; on ties the innermost node wins, so a wrapper whose
 *  only content is the target cannot outrank the target itself. */
const byScore = (a: ScoredNode, b: ScoredNode): number => b.score - a.score || b.depth - a.depth;

/** Siblings considered on EACH side of an element, by capture and engine alike. */
export const SIBLING_WINDOW = 5;

/** `label[for]` → label text, built once per parsed DOM (first label wins,
 *  like `querySelector`) instead of one document scan per candidate. */
const labelIndex = new WeakMap<cheerio.CheerioAPI, Map<string, string>>();
function labelsByFor($: cheerio.CheerioAPI): Map<string, string> {
  let index = labelIndex.get($);
  if (!index) {
    index = new Map();
    for (const el of $('label[for]').toArray()) {
      const target = $(el).attr('for');
      if (target !== undefined && !index.has(target)) {
        index.set(target, $(el).text().replace(/\s+/g, ' ').trim());
      }
    }
    labelIndex.set($, index);
  }
  return index;
}

// shortcut: only the top 50 lexical candidates are embedded; raise if semantic matches rank lower.
const EMBED_POOL = 50;
// Container texts can be huge; clip so no input blows an endpoint's per-input token limit.
const EMBED_MAX_CHARS = 2_000;

const DEFAULT_WEIGHTS: HealingWeights = {
  text: 0.45,
  tag: 0.10,
  id: 0.05,
  classes: 0.10,
  attributes: 0.10,
  anchor: 0.20,
};

const DEFAULT_ANCHOR_WEIGHTS: AnchorWeights = {
  labelText: 0.40,
  parentText: 0.20,
  ariaLabel: 0.15,
  dataTestId: 0.10,
  siblings: 0.15,
};

export class SelfHealingEngine {
  private readonly weights: HealingWeights;
  private readonly anchorWeights: AnchorWeights;
  private readonly threshold: number;
  private readonly topN: number;
  private readonly embeddings?: Required<EmbeddingOptions>;

  constructor(options: SelfHealingEngineOptions = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...(options.weights ?? {}) };
    this.anchorWeights = { ...DEFAULT_ANCHOR_WEIGHTS, ...(options.anchorWeights ?? {}) };
    this.threshold = options.threshold ?? 0.6;
    this.topN = options.topN ?? 5;
    if (options.embeddings) {
      const { provider, weight = 0.5, baseline = 0.5 } = options.embeddings;
      if (!(weight >= 0 && weight <= 1)) {
        throw new Error(`[SelfHealingEngine] embeddings.weight must be in [0, 1], got ${weight}`);
      }
      if (!(baseline >= 0 && baseline < 1)) {
        throw new Error(`[SelfHealingEngine] embeddings.baseline must be in [0, 1), got ${baseline}`);
      }
      this.embeddings = { provider, weight, baseline };
    }
  }

  /**
   * Score the DOM and return the best match for `meta`.
   *
   * @param domHtml The full HTML of the page (e.g. `await page.content()`).
   * @param meta    The historical metadata of the target element.
   */
  public async heal(domHtml: string, meta: ElementMetaData): Promise<HealResult> {
    const $ = cheerio.load(domHtml);

    // First pass: nodes that share the expected tag. If none clears the
    // threshold (the element may have been re-tagged while other same-tag
    // nodes remain), relax to every element in the body. Matched by name,
    // not by selector: a stored tag like `x:btn` is not valid CSS.
    const metaText = meta.textContent.trim();
    let embeddingsUsed = false;
    let warning: string | undefined;
    // Lexical scores, plus the embedding blend when configured – applied per
    // pass, so a reworded same-tag element can heal before the scan widens.
    const rank = async (nodes: CheerioNode[]): Promise<ScoredNode[]> => {
      const scored = this.scoreAll($, nodes, meta);
      embeddingsUsed = false;
      if (this.embeddings && metaText && !warning) {
        try {
          embeddingsUsed = await this.blendEmbeddings(scored, metaText, this.embeddings);
        } catch (err) {
          // Never fail a heal because the provider is down: keep lexical scores.
          warning = `Embedding provider failed, kept lexical text scores: ${(err as Error).message}`;
        }
      }
      return scored;
    };

    const tag = meta.tagName.toLowerCase();
    const sameTag = ($('*').toArray() as CheerioNode[]).filter(n => n.name?.toLowerCase() === tag);
    let scored = await rank(sameTag);
    if (scored.length === 0 || scored[0].score < this.threshold) {
      scored = await rank($('body *').toArray() as CheerioNode[]);
    }

    // Selectors are only built for the nodes we report – each one runs
    // uniqueness queries against the DOM.
    const top = scored
      .slice(0, Math.max(this.topN, 1))
      .map(s => this.toCandidate($, s));
    const best = top[0];
    const healed = !!best && best.score >= this.threshold;

    return {
      healed,
      confidence: best?.score ?? 0,
      selector: healed ? best.selector : undefined,
      candidate: healed ? best : undefined,
      candidatesEvaluated: scored.length,
      topCandidates: top.slice(0, this.topN),
      embeddingsUsed,
      warning,
    };
  }

  // --------------------------------------------------------------------
  // Scoring
  // --------------------------------------------------------------------

  private scoreAll(
    $: cheerio.CheerioAPI,
    nodes: CheerioNode[],
    meta: ElementMetaData,
  ): ScoredNode[] {
    return nodes
      .filter(n => n.type === 'tag' && n.name !== 'script' && n.name !== 'style')
      .map(node => this.scoreNode($, node, meta))
      .sort(byScore);
  }

  private blend(parts: Record<keyof HealingWeights, number>): number {
    return (
      parts.text       * this.weights.text +
      parts.tag        * this.weights.tag +
      parts.id         * this.weights.id +
      parts.classes    * this.weights.classes +
      parts.attributes * this.weights.attributes +
      parts.anchor     * this.weights.anchor
    );
  }

  /**
   * Blend embedding similarity into the text signal of the top lexical
   * candidates (`text = (1-w)·levenshtein + w·similarity`, where similarity
   * is the cosine rescaled above `baseline`), re-score and re-sort `scored`
   * in place. Returns false when nothing could be embedded.
   */
  private async blendEmbeddings(
    scored: ScoredNode[],
    metaText: string,
    { provider, weight, baseline }: Required<EmbeddingOptions>,
  ): Promise<boolean> {
    const pool = scored.slice(0, EMBED_POOL).filter(s => s.text);
    if (pool.length === 0) return false;

    const clip = (t: string): string => t.slice(0, EMBED_MAX_CHARS);
    const texts = [...new Set([metaText, ...pool.map(s => s.text)].map(clip))];
    const vectors = await provider.embed(texts);
    // Any provider can be plugged in, so validate what came back.
    if (
      !Array.isArray(vectors) || vectors.length !== texts.length ||
      !vectors.every(v => Array.isArray(v) && v.length > 0 && v.every(Number.isFinite))
    ) {
      throw new Error(`provider returned malformed vectors for ${texts.length} texts`);
    }

    const vectorOf = new Map(texts.map((t, i) => [t, vectors[i]]));
    const target = vectorOf.get(clip(metaText)) ?? [];
    for (const s of pool) {
      const cosine = SimilarityUtils.cosine(target, vectorOf.get(clip(s.text)) ?? []);
      const similarity = Math.max(0, (cosine - baseline) / (1 - baseline));
      s.parts.text = (1 - weight) * s.parts.text + weight * similarity;
      s.score = this.clampScore(this.blend(s.parts));
    }
    scored.sort(byScore);
    return true;
  }

  private scoreNode(
    $: cheerio.CheerioAPI,
    node: CheerioNode,
    meta: ElementMetaData,
  ): ScoredNode {
    // cheerio's `$(node)` accepts any DOM-handler node; the namespace cast
    // is a one-liner concession to cheerio's fluid typings.
    const $node = $(node as unknown as cheerio.Element);
    const tagName = (node.name ?? 'unknown').toLowerCase();
    const attribs: Record<string, string> = node.attribs ?? {};
    const id = attribs['id'] ?? '';
    const classAttr = attribs['class'] ?? '';
    const classes = classAttr.split(/\s+/).filter(Boolean);
    const text = $node.text().replace(/\s+/g, ' ').trim();

    // --- tag -----------------------------------------------------------
    const tagScore = tagName === meta.tagName.toLowerCase() ? 1 : 0.3;

    // --- visible text --------------------------------------------------
    const textScore = SimilarityUtils.stringSimilarity(text, meta.textContent);

    // --- id ------------------------------------------------------------
    // If no id was captured historically we cannot gain signal either way,
    // so we return a neutral 0.5 – neither rewarding nor penalising.
    const idScore = meta.id
      ? SimilarityUtils.stringSimilarity(id, meta.id)
      : 0.5;

    // --- classes (tokenised Jaccard) ----------------------------------
    const classScore = SimilarityUtils.jaccard(
      classes.flatMap(c => SimilarityUtils.tokenize(c)),
      (meta.classes ?? []).flatMap(c => SimilarityUtils.tokenize(c)),
    );

    // --- attributes ----------------------------------------------------
    const attrScore = this.scoreAttributes(attribs, meta.attributes ?? {});

    // --- anchor context -----------------------------------------------
    const anchorScore = this.scoreAnchor($, $node, attribs, id, meta);

    const parts = {
      text: textScore,
      tag: tagScore,
      id: idScore,
      classes: classScore,
      attributes: attrScore,
      anchor: anchorScore,
    };
    return {
      node,
      attribs,
      depth: $node.parents().length,
      score: this.clampScore(this.blend(parts)),
      tagName,
      id,
      classes,
      text,
      parts,
    };
  }

  private toCandidate($: cheerio.CheerioAPI, s: ScoredNode): HealCandidate {
    const { selector, nth } = this.buildSelector($, s.node, s.tagName, s.id, s.classes, s.attribs);
    const round = (v: number): number => Number(v.toFixed(4));
    return {
      selector,
      nth,
      xpath: this.buildXPath(s.tagName, s.id, s.classes, s.attribs, s.text),
      score: s.score,
      tagName: s.tagName,
      id: s.id || undefined,
      classes: s.classes,
      textContent: s.text,
      breakdown: {
        text: round(s.parts.text),
        tag: round(s.parts.tag),
        id: round(s.parts.id),
        classes: round(s.parts.classes),
        attributes: round(s.parts.attributes),
        anchor: round(s.parts.anchor),
      },
    };
  }

  /**
   * How many of the expected attributes are present on the current node
   * with a fuzzy-matching value ≥ 0.7? Returns [0, 1].
   *
   * We ignore high-churn keys (`id`, `class`, `style`) because their signal
   * is already captured by dedicated sub-scores and their values are the
   * first thing to change between builds.
   */
  private scoreAttributes(
    current: Record<string, string>,
    expected: Record<string, string>,
  ): number {
    const ignore = new Set(['id', 'class', 'style']);
    const keys = Object.keys(expected).filter(k => !ignore.has(k));
    if (keys.length === 0) return 0.5; // no information → neutral

    let matched = 0;
    for (const key of keys) {
      const currentVal = current[key];
      const expectedVal = expected[key];
      if (currentVal === undefined) continue;
      if (SimilarityUtils.stringSimilarity(currentVal, expectedVal) >= 0.7) {
        matched++;
      }
    }
    return matched / keys.length;
  }

  /**
   * Anchor (context) sub-score. Each factor is a Levenshtein / Jaccard
   * similarity to its historical counterpart; the weighted blend is
   * defined by {@link AnchorWeights}.
   */
  private scoreAnchor(
    $: cheerio.CheerioAPI,
    $node: cheerio.Cheerio<cheerio.Element>,
    attribs: Record<string, string>,
    id: string,
    meta: ElementMetaData,
  ): number {
    const ctx = meta.anchorContext ?? { siblingTexts: [] };

    // Parent's OWN text (its direct text nodes, excluding descendants).
    const $parent = $node.parent();
    const parentText = $parent
      .contents()
      .filter((_, n) => (n as CheerioNode).type === 'text')
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    const parentTextScore = SimilarityUtils.stringSimilarity(
      parentText,
      ctx.parentText ?? '',
    );

    // Associated label (matches by `for=` or by wrapping).
    const labelText = this.findLabelText($, $node, id);
    const labelScore = SimilarityUtils.stringSimilarity(
      labelText,
      ctx.labelText ?? '',
    );

    const ariaScore = SimilarityUtils.stringSimilarity(
      attribs['aria-label'] ?? '',
      ctx.ariaLabel ?? '',
    );
    const testIdScore = SimilarityUtils.stringSimilarity(
      attribs['data-testid'] ?? attribs['data-test'] ?? '',
      ctx.dataTestId ?? '',
    );

    // Sibling text overlap – tokenised Jaccard so small wording changes
    // do not destroy the match. Only the nearest SIBLING_WINDOW siblings on
    // each side count (the browser capture uses the same window): reading
    // every sibling is quadratic in long lists, and far-away rows are noise.
    const siblings = $parent.children().toArray();
    const at = siblings.indexOf($node.get(0) as cheerio.Element);
    const siblingTexts = [
      ...siblings.slice(Math.max(0, at - SIBLING_WINDOW), at),
      ...siblings.slice(at + 1, at + 1 + SIBLING_WINDOW),
    ]
      .map(el => $(el).text().trim())
      .filter(Boolean);
    const siblingScore = SimilarityUtils.jaccard(
      siblingTexts.flatMap(t => SimilarityUtils.tokenize(t)),
      (ctx.siblingTexts ?? []).flatMap(t => SimilarityUtils.tokenize(t)),
    );

    return this.clampScore(
      labelScore      * this.anchorWeights.labelText +
      parentTextScore * this.anchorWeights.parentText +
      ariaScore       * this.anchorWeights.ariaLabel +
      testIdScore     * this.anchorWeights.dataTestId +
      siblingScore    * this.anchorWeights.siblings,
    );
  }

  private findLabelText(
    $: cheerio.CheerioAPI,
    $node: cheerio.Cheerio<cheerio.Element>,
    id: string,
  ): string {
    if (id) {
      const byFor = labelsByFor($).get(id);
      if (byFor !== undefined) return byFor;
    }
    const wrapping = $node.parents('label').first();
    if (wrapping.length) return wrapping.text().replace(/\s+/g, ' ').trim();
    return '';
  }

  // --------------------------------------------------------------------
  // Selector construction
  // --------------------------------------------------------------------

  /**
   * Produce the most STABLE CSS selector that points at exactly this node,
   * preferring purpose-built attributes (`data-testid`, `data-test`) over
   * incidental ones (id, class). Strategies are tried in that order and the
   * first one that is unique in the DOM wins; if none is unique, the first
   * one that matches is kept together with the node's index among its
   * matches, so callers never silently act on a look-alike.
   */
  private buildSelector(
    $: cheerio.CheerioAPI,
    node: CheerioNode,
    tag: string,
    id: string,
    classes: string[],
    attrs: Record<string, string>,
  ): { selector: string; nth: number } {
    const t = this.cssIdent(tag); // e.g. `x:btn` → `x\:btn`
    const strategies = [
      attrs['data-testid'] && `[data-testid="${this.escapeValue(attrs['data-testid'])}"]`,
      attrs['data-test'] && `[data-test="${this.escapeValue(attrs['data-test'])}"]`,
      id && `#${this.cssIdent(id)}`,
      attrs['aria-label'] && `${t}[aria-label="${this.escapeValue(attrs['aria-label'])}"]`,
      attrs['name'] && `${t}[name="${this.escapeValue(attrs['name'])}"]`,
      classes.length > 0 && `${t}${classes.slice(0, 2).map(c => `.${this.cssIdent(c)}`).join('')}`,
      t,
    ].filter((s): s is string => !!s);

    let fallback: { selector: string; nth: number } | undefined;
    for (const selector of strategies) {
      let matches: unknown[];
      try {
        matches = $(selector).toArray();
      } catch {
        continue; // css-select cannot parse this form – try the next one
      }
      const nth = matches.indexOf(node);
      if (nth === -1) continue;
      if (matches.length === 1) return { selector, nth: 0 };
      fallback ??= { selector, nth };
    }
    return fallback ?? { selector: t, nth: 0 };
  }

  /**
   * Produce an XPath that points at the same node. Mirrors {@link buildSelector}'s
   * priority, with one XPath-exclusive super-power: a visible-text match
   * (`normalize-space()='...'`) which CSS cannot express and which is
   * typically the most stable locator for buttons, links and labels.
   */
  private buildXPath(
    tag: string,
    id: string,
    classes: string[],
    attrs: Record<string, string>,
    text: string,
  ): string {
    if (attrs['data-testid']) return `//*[@data-testid=${this.xpathLiteral(attrs['data-testid'])}]`;
    if (attrs['data-test'])   return `//*[@data-test=${this.xpathLiteral(attrs['data-test'])}]`;
    if (id)                   return `//*[@id=${this.xpathLiteral(id)}]`;
    if (attrs['aria-label'])  return `//${tag}[@aria-label=${this.xpathLiteral(attrs['aria-label'])}]`;
    if (attrs['name'])        return `//${tag}[@name=${this.xpathLiteral(attrs['name'])}]`;

    // Text-based match – only useful when the element has its own visible
    // text (buttons, links, labels). Uses `normalize-space()` so that
    // whitespace/line-break diffs don't break the match.
    const textNodes = new Set(['button', 'a', 'label', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li']);
    if (text && textNodes.has(tag)) {
      return `//${tag}[normalize-space()=${this.xpathLiteral(text)}]`;
    }

    if (classes.length) {
      // XPath has no native class selector; use the canonical contains()
      // trick with space padding to avoid partial-token hits.
      const parts = classes
        .slice(0, 2)
        .map(c => `contains(concat(' ', normalize-space(@class), ' '), ' ${c} ')`);
      return `//${tag}[${parts.join(' and ')}]`;
    }
    return `//${tag}`;
  }

  private cssIdent(value: string): string {
    // Escape characters that are illegal in CSS identifiers, and a leading
    // digit (optionally after "-") as a hex escape, like CSS.escape does.
    return value
      .replace(/([^a-zA-Z0-9_-])/g, '\\$1')
      .replace(/^(-?)(\d)/, (_m, dash: string, digit: string) => `${dash}\\3${digit} `);
  }

  private escapeValue(value: string): string {
    // CSS strings cannot hold raw line breaks; `\a ` / `\d ` are their escapes.
    return value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\a ')
      .replace(/\r/g, '\\d ');
  }

  /**
   * Wrap a literal for safe inclusion in an XPath expression. XPath has no
   * escape syntax, so strings containing BOTH `'` and `"` have to be
   * expressed via `concat()`.
   */
  private xpathLiteral(value: string): string {
    if (!value.includes("'")) return `'${value}'`;
    if (!value.includes('"')) return `"${value}"`;
    // Contains both quote flavours – fall back to concat().
    const parts = value.split("'").map(p => `'${p}'`).join(`, "'", `);
    return `concat(${parts})`;
  }

  private clampScore(value: number): number {
    if (Number.isNaN(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return Number(value.toFixed(4));
  }
}
