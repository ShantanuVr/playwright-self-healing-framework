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
 */

import * as cheerio from 'cheerio';
import { ElementMetaData } from '../storage/ElementMetaData';
import { SimilarityUtils } from './SimilarityUtils';

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
  selector?: string;
  candidate?: HealCandidate;
  candidatesEvaluated: number;
  /** Top-N candidates, included in reports for auditability. */
  topCandidates: HealCandidate[];
}

export interface SelfHealingEngineOptions {
  weights?: Partial<HealingWeights>;
  anchorWeights?: Partial<AnchorWeights>;
  /** Minimum score required to accept a candidate (default 0.6). */
  threshold?: number;
  /** Keep top-N candidates in {@link HealResult.topCandidates}. Default 5. */
  topN?: number;
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
  breakdown: Record<keyof HealingWeights, number>;
}

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

  constructor(options: SelfHealingEngineOptions = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...(options.weights ?? {}) };
    this.anchorWeights = { ...DEFAULT_ANCHOR_WEIGHTS, ...(options.anchorWeights ?? {}) };
    this.threshold = options.threshold ?? 0.6;
    this.topN = options.topN ?? 5;
  }

  /**
   * Score the DOM and return the best match for `meta`.
   *
   * @param domHtml The full HTML of the page (e.g. `await page.content()`).
   * @param meta    The historical metadata of the target element.
   */
  public heal(domHtml: string, meta: ElementMetaData): HealResult {
    const $ = cheerio.load(domHtml);

    // First pass: nodes that share the expected tag. If none clears the
    // threshold (the element may have been re-tagged while other same-tag
    // nodes remain), relax to every element in the body.
    let scored = this.scoreAll($, $(meta.tagName.toLowerCase()).toArray() as CheerioNode[], meta);
    if (scored.length === 0 || scored[0].score < this.threshold) {
      scored = this.scoreAll($, $('body *').toArray() as CheerioNode[], meta);
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
      // Highest score first; on ties the innermost node wins, so a wrapper
      // whose only content is the target cannot outrank the target itself.
      .sort((a, b) => b.score - a.score || b.depth - a.depth);
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

    // --- blend ---------------------------------------------------------
    const total =
      textScore   * this.weights.text +
      tagScore    * this.weights.tag +
      idScore     * this.weights.id +
      classScore  * this.weights.classes +
      attrScore   * this.weights.attributes +
      anchorScore * this.weights.anchor;

    return {
      node,
      attribs,
      depth: $node.parents().length,
      score: this.clampScore(total),
      tagName,
      id,
      classes,
      text,
      breakdown: {
        text: Number(textScore.toFixed(4)),
        tag: Number(tagScore.toFixed(4)),
        id: Number(idScore.toFixed(4)),
        classes: Number(classScore.toFixed(4)),
        attributes: Number(attrScore.toFixed(4)),
        anchor: Number(anchorScore.toFixed(4)),
      },
    };
  }

  private toCandidate($: cheerio.CheerioAPI, s: ScoredNode): HealCandidate {
    const { selector, nth } = this.buildSelector($, s.node, s.tagName, s.id, s.classes, s.attribs);
    return {
      selector,
      nth,
      xpath: this.buildXPath(s.tagName, s.id, s.classes, s.attribs, s.text),
      score: s.score,
      tagName: s.tagName,
      id: s.id || undefined,
      classes: s.classes,
      textContent: s.text,
      breakdown: s.breakdown,
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
    // do not destroy the match.
    const siblingTexts: string[] = [];
    $parent.children().each((_: number, el: cheerio.Element) => {
      if (el === ($node.get(0) as unknown)) return;
      const t = $(el).text().trim();
      if (t) siblingTexts.push(t);
    });
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
      const byFor = $(`label[for="${this.escapeValue(id)}"]`).first();
      if (byFor.length) return byFor.text().replace(/\s+/g, ' ').trim();
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
    const strategies = [
      attrs['data-testid'] && `[data-testid="${this.escapeValue(attrs['data-testid'])}"]`,
      attrs['data-test'] && `[data-test="${this.escapeValue(attrs['data-test'])}"]`,
      id && `#${this.cssIdent(id)}`,
      attrs['aria-label'] && `${tag}[aria-label="${this.escapeValue(attrs['aria-label'])}"]`,
      attrs['name'] && `${tag}[name="${this.escapeValue(attrs['name'])}"]`,
      classes.length > 0 && `${tag}${classes.slice(0, 2).map(c => `.${this.cssIdent(c)}`).join('')}`,
      tag,
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
    return fallback ?? { selector: tag, nth: 0 };
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
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
