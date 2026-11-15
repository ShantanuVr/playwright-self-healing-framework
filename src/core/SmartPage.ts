/**
 * @file SmartPage.ts
 * @description Custom Action Wrapper that sits in front of Playwright's
 *              {@link Page} and makes every interaction "self-healing".
 *
 *              Responsibilities:
 *               1. Resolve the effective primary selector for a logical
 *                  element name – preferring the last successfully used
 *                  selector from storage over hard-coded hints.
 *               2. Attempt the action with the primary selector first.
 *               3. On a Playwright TimeoutError (or any locator-related
 *                  error), hand the current DOM off to the
 *                  {@link SelfHealingEngine}, receive a healed selector,
 *                  retry the action, and persist the new selector.
 *               4. Snapshot the element's {@link ElementMetaData} just
 *                  BEFORE each interaction and persist it once the
 *                  interaction succeeds, so the "training data" stays in
 *                  sync with production. Snapshotting first matters: an
 *                  action may navigate away or remove its own element.
 *               5. Delegate logging to the {@link StateReporter} – this
 *                  class never prints or asserts on its own.
 *
 * SOLID notes:
 *  - SRP: orchestration only; similarity math, storage, and reporting are
 *    injected collaborators.
 *  - OCP / DIP: depends on {@link IMetadataStore} (abstraction), not on
 *    JsonMetadataStore.
 *  - Assertions are untouched – callers use `expect()` on `page.raw` or on
 *    `expectVisible()`. The healing logic never throws its own assertion.
 */

import { Page, Locator, errors as pwErrors, expect } from '@playwright/test';
import { IMetadataStore } from '../storage/IMetadataStore';
import {
  ElementMetaData,
  HealingOutcome,
  HealReplay,
  AnchorContext,
} from '../storage/ElementMetaData';
import {
  SelfHealingEngine,
  HealCandidate,
  HealResult,
  SIBLING_WINDOW,
  toLocatorString,
} from '../healing/SelfHealingEngine';
import { StateReporter } from '../reporting/StateReporter';

export interface SmartPageOptions {
  store: IMetadataStore;
  engine: SelfHealingEngine;
  reporter: StateReporter;
  /** Per-action timeout in ms (default 4000). */
  defaultTimeoutMs?: number;
  /**
   * Controls whether successful interactions update the metadata store.
   * - `auto` (default): always capture.
   * - `readonly`: never write to the store (useful for audit runs).
   */
  captureMode?: 'auto' | 'readonly';
}

/** The action operates on a resolved Playwright {@link Locator}. */
type InteractionFn = (locator: Locator) => Promise<void>;

/**
 * Snapshot harvested from the browser just before an interaction.
 * Mirrors – but is NOT identical to – {@link ElementMetaData} because it
 * omits persistence-only fields (logicalName, primarySelector).
 */
interface DomSnapshot {
  tagName: string;
  id?: string;
  classes: string[];
  textContent: string;
  attributes: Record<string, string>;
  anchor: AnchorContext;
  /** Pathname at snapshot time – read before the action can navigate. */
  pageUrlPattern: string;
}

export class SmartPage {
  private readonly page: Page;
  private readonly store: IMetadataStore;
  private readonly engine: SelfHealingEngine;
  private readonly reporter: StateReporter;
  private readonly timeout: number;
  private readonly captureMode: 'auto' | 'readonly';
  private readonly registry: Map<string, string> = new Map();

  constructor(page: Page, options: SmartPageOptions) {
    this.page = page;
    this.store = options.store;
    this.engine = options.engine;
    this.reporter = options.reporter;
    this.timeout = options.defaultTimeoutMs ?? 4_000;
    this.captureMode = options.captureMode ?? 'auto';
  }

  /** Escape hatch – the raw Playwright page for anything we don't wrap. */
  public get raw(): Page {
    return this.page;
  }

  /**
   * Register a static mapping `logicalName → selector` (used when no
   * inline hint is passed and storage has no entry yet).
   */
  public register(logicalName: string, selector: string): void {
    this.registry.set(logicalName, selector);
  }

  // --------------------------------------------------------------------
  // Public interaction API
  // --------------------------------------------------------------------

  public async click(logicalName: string, selectorHint?: string): Promise<void> {
    await this.perform(logicalName, selectorHint, async (loc) => {
      await loc.click({ timeout: this.timeout });
    });
  }

  public async fill(
    logicalName: string,
    value: string,
    selectorHint?: string,
  ): Promise<void> {
    await this.perform(logicalName, selectorHint, async (loc) => {
      await loc.fill(value, { timeout: this.timeout });
    });
  }

  public async text(logicalName: string, selectorHint?: string): Promise<string> {
    let result = '';
    await this.perform(logicalName, selectorHint, async (loc) => {
      result = (await loc.textContent({ timeout: this.timeout })) ?? '';
    });
    return result;
  }

  public async expectVisible(
    logicalName: string,
    selectorHint?: string,
  ): Promise<void> {
    await this.perform(logicalName, selectorHint, async (loc) => {
      await expect(loc).toBeVisible({ timeout: this.timeout });
    });
  }

  // --------------------------------------------------------------------
  // Core orchestration
  // --------------------------------------------------------------------

  private async perform(
    logicalName: string,
    selectorHint: string | undefined,
    action: InteractionFn,
  ): Promise<void> {
    await this.store.load();

    const primary = this.resolvePrimary(logicalName, selectorHint);
    if (!primary) {
      throw new Error(
        `[SmartPage] No selector available for logical name "${logicalName}". ` +
          `Provide a selectorHint, call register(), or seed metadata first.`,
      );
    }

    const startedAt = Date.now();
    // A positional selector (`>> nth=N`) follows DOM order, not the element:
    // once rows are inserted it silently points at a look-alike. Re-check it
    // against the fingerprint before trusting it as an exact match.
    if (primary.includes(' >> nth=') && (await this.positionalDrifted(logicalName, primary))) {
      return this.recover(
        logicalName,
        primary,
        action,
        startedAt,
        new Error(`Positional selector "${primary}" no longer points at the recorded element.`),
      );
    }

    // Stored selectors resolve strictly: if one has turned ambiguous since it
    // was recorded, Playwright's strict-mode error triggers a heal instead of
    // the first match being used silently. Hints with no history keep `.first()`.
    const locator = this.store.get(logicalName)
      ? this.page.locator(primary)
      : this.page.locator(primary).first();
    let snap: DomSnapshot | undefined;
    try {
      snap = await this.captureBefore(locator);
      await action(locator);
    } catch (err) {
      if (!this.isInteractionError(err)) throw err;
      return this.recover(logicalName, primary, action, startedAt, err as Error);
    }

    // Persisting happens outside the try: a storage error must surface as
    // itself, never be mistaken for a broken locator.
    if (snap) await this.store.upsert(this.toMeta(logicalName, primary, snap));
    this.reporter.record({
      logicalName,
      originalSelector: primary,
      healedSelector: primary,
      confidence: 1,
      strategy: 'exact',
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });
  }

  /** Heal, record the outcome, and re-throw `err` (decorated) if healing failed. */
  private async recover(
    logicalName: string,
    primary: string,
    action: InteractionFn,
    startedAt: number,
    err: Error,
  ): Promise<void> {
    const outcome = await this.attemptHeal(logicalName, primary, action);
    outcome.durationMs = Date.now() - startedAt;
    this.reporter.record(outcome);

    if (outcome.strategy === 'failed') {
      // Re-throw a decorated version of the original error so users still
      // see the full Playwright context (including trace), but with the
      // healing diagnostics attached.
      err.message = `${err.message}\n[SelfHealing] ${outcome.reason ?? 'unknown heal failure'}`;
      throw err;
    }
  }

  /**
   * Does a positional primary still resolve to the element its fingerprint
   * describes? Asks the engine on the live DOM: when it confidently picks a
   * different match, the stored index has drifted. Costs one DOM read, and
   * only for elements that never had a unique selector.
   */
  private async positionalDrifted(logicalName: string, primary: string): Promise<boolean> {
    const meta = this.store.get(logicalName);
    if (!meta) return false;
    try {
      const result = await this.engine.heal(await this.readDom(), meta);
      if (!result.healed || !result.candidate) return false;
      return (await this.playwrightLocator(result.candidate)) !== primary;
    } catch {
      return false; // can't check: keep trusting the stored selector, as before
    }
  }

  private resolvePrimary(
    logicalName: string,
    selectorHint: string | undefined,
  ): string | undefined {
    // Storage wins – that selector is known to have worked most recently
    // (or was just healed). Falls back to registry, then inline hint.
    return (
      this.store.get(logicalName)?.primarySelector ??
      this.registry.get(logicalName) ??
      selectorHint
    );
  }

  /**
   * Try to recover a broken interaction by handing the current DOM to the
   * healing engine. Every locator or engine problem is returned as a
   * {@link HealingOutcome}; only storage errors propagate.
   */
  private async attemptHeal(
    logicalName: string,
    failedSelector: string,
    action: InteractionFn,
  ): Promise<HealingOutcome> {
    const meta = this.store.get(logicalName);
    const timestamp = new Date().toISOString();
    // Set once the DOM has been read, so every later outcome can be replayed.
    let replay: HealReplay | undefined;
    const fail = (
      reason: string,
      confidence = 0,
      healedSelector?: string,
    ): HealingOutcome => ({
      logicalName,
      originalSelector: failedSelector,
      healedSelector,
      confidence,
      strategy: 'failed',
      reason,
      durationMs: 0,
      timestamp,
      replay,
    });

    if (!meta) {
      return fail('No historical metadata for this logical name – nothing to heal from.');
    }

    let domHtml: string;
    try {
      domHtml = await this.readDom();
    } catch (contentErr) {
      return fail(`Unable to read DOM: ${(contentErr as Error).message}`);
    }
    replay = { meta, dom: domHtml };

    let result: HealResult;
    try {
      result = await this.engine.heal(domHtml, meta);
    } catch (engineErr) {
      return fail(`Healing engine error: ${(engineErr as Error).message}`);
    }
    if (result.embeddingsUsed) replay.embeddings = true;
    const warningNote = result.warning ? ` ${result.warning}` : '';

    const candidate = result.candidate;
    if (result.healed && candidate) replay.engineSelector = toLocatorString(candidate);
    if (!result.healed || !candidate) {
      return fail(
        `No DOM candidate met the confidence threshold. ` +
          `Best score=${result.confidence.toFixed(3)} ` +
          `across ${result.candidatesEvaluated} candidates.${warningNote}`,
        result.confidence,
      );
    }

    // Try the CSS healed selector first (with `>> nth=N` when the CSS form
    // also matches look-alikes); if that throws at action time, fall back
    // to the XPath expression the engine produced for the same candidate.
    const cssLocator = await this.playwrightLocator(candidate);
    const attempts: Array<{ locatorExpr: string; kind: 'css' | 'xpath' }> = [
      { locatorExpr: cssLocator, kind: 'css' },
      { locatorExpr: `xpath=${candidate.xpath}`, kind: 'xpath' },
    ];
    // Surfaced in the reason so near-ties are visible in the audit trail.
    const runnerUp = result.topCandidates[1]?.score;
    const runnerUpNote = runnerUp === undefined ? '' : ` (runner-up ${runnerUp.toFixed(3)})`;

    let lastError: Error | undefined;
    for (const attempt of attempts) {
      // Nothing proves the XPath is unique, and `.first()` would pick a
      // look-alike: use it only when exactly one element matches.
      if (
        attempt.kind === 'xpath' &&
        (await this.page.locator(attempt.locatorExpr).count().catch(() => 0)) !== 1
      ) {
        lastError = new Error(`XPath fallback ${attempt.locatorExpr} skipped: it does not match exactly one element.`);
        continue;
      }
      const healedLocator = this.page.locator(attempt.locatorExpr).first();
      let snap: DomSnapshot | undefined;
      try {
        // The fingerprint is re-captured from the healed node's CURRENT DOM
        // state. Without this, anchor context (siblings, label, attributes)
        // stays anchored to the original UI and each additional mutation
        // would score against stale "training data".
        snap = await this.captureBefore(healedLocator);
        await action(healedLocator);
      } catch (retryErr) {
        lastError = retryErr as Error;
        continue;
      }

      if (snap) {
        // Append the broken selector to the rolling audit trail – read fresh,
        // so a parallel worker's entries are extended rather than dropped.
        const current = this.store.get(logicalName) ?? meta;
        const healedFrom = Array.from(
          new Set([...(current.healedFrom ?? []), failedSelector]),
        ).slice(-10);
        await this.store.upsert({
          ...this.toMeta(logicalName, attempt.locatorExpr, snap),
          healedFrom,
        });
      }

      return {
        logicalName,
        originalSelector: failedSelector,
        healedSelector: attempt.locatorExpr,
        confidence: result.confidence,
        strategy: 'healed',
        reason:
          `Matched "${candidate.textContent}" ` +
          `via ${attempt.kind.toUpperCase()} with score ${result.confidence.toFixed(3)}${runnerUpNote}.${warningNote}`,
        durationMs: 0,
        timestamp,
        replay,
      };
    }

    return fail(
      `Healed selector(s) failed on retry: ${lastError?.message ?? 'unknown'}`,
      result.confidence,
      cssLocator,
    );
  }

  /**
   * Translate the engine's `nth` – document order of the flattened DOM, in
   * which shadow children precede their host's light children – into
   * Playwright's own match order, which lists a tree's light nodes before
   * its shadow roots' nodes. Every selector strategy is a single compound
   * selector, so both sides match the same set; only the order differs, and
   * mapping the target element between the two orders is exact.
   */
  private async playwrightLocator(candidate: HealCandidate): Promise<string> {
    let index = candidate.nth;
    let matches = candidate.nth > 0 ? 2 : 1;
    try {
      [index, matches] = await this.page.locator(candidate.selector).evaluateAll((els, nth) => {
        const all = new Set<Element>(els);
        const flatOrder: Element[] = [];
        const walk = (n: Node): void => {
          if (n instanceof Element) {
            if (all.has(n)) flatOrder.push(n);
            n.shadowRoot?.childNodes.forEach(walk);
          }
          n.childNodes.forEach(walk);
        };
        walk(document.documentElement);
        const target = flatOrder[nth];
        const i = target ? (els as Element[]).indexOf(target) : -1;
        return [i >= 0 ? i : nth, els.length] as [number, number];
      }, candidate.nth);
    } catch {
      // Playwright rejected the selector: keep the engine's view. The
      // action then fails on its own and falls through to the XPath attempt.
    }
    // Any ambiguous selector carries its index – even 0 – so later runs
    // re-check it (see positionalDrifted) instead of trusting the first match.
    return matches > 1 ? `${candidate.selector} >> nth=${index}` : candidate.selector;
  }

  /**
   * Detect errors that indicate the locator is broken, as opposed to true
   * application errors we must not swallow. We prefer `instanceof
   * TimeoutError` but fall back to a message heuristic because some error
   * types get re-thrown through async boundaries and lose their prototype.
   */
  private isInteractionError(err: unknown): boolean {
    if (!err) return false;
    if (err instanceof pwErrors.TimeoutError) return true;
    const message = (err as Error).message ?? '';
    return /timeout|waiting for (?:selector|locator)|not visible|no element|strict mode violation/i.test(
      message,
    );
  }

  // --------------------------------------------------------------------
  // Browser-side evaluation: DOM serialisation & metadata capture
  // --------------------------------------------------------------------

  /**
   * Serialise the live DOM for the engine, inlining every OPEN shadow root
   * into its host (before the host's light children) so shadow content can
   * be scored. Nodes are copied into an inert document: copying inside the
   * live one would upgrade custom elements (re-running their constructors)
   * and could start loading cloned media.
   */
  private async readDom(): Promise<string> {
    return this.page.evaluate(() => {
      const doc = document.implementation.createHTMLDocument('');
      // shortcut: <slot> content is not distributed (shadow children precede
      // light children); use assignedNodes() if slotted elements score poorly.
      // shortcut: the engine re-parses this markup with HTML repair rules, so
      // shadow content the parser would restructure (block elements inside a
      // <p> host, custom elements in table context) scores with shifted
      // context; serialise a node tree instead of HTML if that ever matters.
      const flat = (n: Node): Node => {
        const copy = doc.importNode(n, false);
        if (n instanceof Element && n.shadowRoot) {
          n.shadowRoot.childNodes.forEach(k => copy.appendChild(flat(k)));
        }
        n.childNodes.forEach(k => copy.appendChild(flat(k)));
        return copy;
      };
      return (flat(document.documentElement) as Element).outerHTML;
    });
  }

  /**
   * Snapshot before an action (auto mode only). A locator error – element
   * missing – is re-thrown so healing kicks in. Anything else, e.g. the
   * execution context being replaced mid-navigation, skips this one capture
   * and leaves the action's own auto-waiting to cope.
   */
  private async captureBefore(locator: Locator): Promise<DomSnapshot | undefined> {
    if (this.captureMode !== 'auto') return undefined;
    try {
      return await this.snapshot(locator);
    } catch (err) {
      if (this.isInteractionError(err)) throw err;
      return undefined;
    }
  }

  /**
   * Harvest the element's fingerprint in the browser. Waits up to the
   * action timeout for the locator to resolve, so a missing element fails
   * here exactly like the action itself would.
   */
  private async snapshot(locator: Locator): Promise<DomSnapshot> {
    return locator.evaluate(
      (el, siblingWindow): DomSnapshot => {
        const node = el as HTMLElement;
        // Mirror the engine's flattened view (see readDom): a top-level node
        // of a shadow root belongs to the host, and a host's children are its
        // open shadow root's children followed by its light children.
        const parent: Element | null =
          node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentElement;
        const kids: ChildNode[] = parent
          ? [...Array.from(parent.shadowRoot?.childNodes ?? []), ...Array.from(parent.childNodes)]
          : [];

        // Attributes
        const attrs: Record<string, string> = {};
        for (const attr of Array.from(node.attributes)) {
          attrs[attr.name] = attr.value;
        }

        // Sibling texts (non-empty): the nearest `siblingWindow` element
        // siblings on each side – the same window the engine scores with.
        const elementKids = kids.filter(child => child.nodeType === Node.ELEMENT_NODE);
        const at = elementKids.indexOf(node);
        const siblingTexts = [
          ...elementKids.slice(Math.max(0, at - siblingWindow), at),
          ...elementKids.slice(at + 1, at + 1 + siblingWindow),
        ]
          .map(child => (child as HTMLElement).innerText?.trim())
          .filter((t): t is string => !!t);

        // Parent's OWN text (exclude descendants).
        let parentText = '';
        kids.forEach((child) => {
          if (child.nodeType === Node.TEXT_NODE) {
            parentText += ` ${child.textContent?.trim() ?? ''}`;
          }
        });
        parentText = parentText.trim();

        // Associated label (by `for=id` within the same tree, or by wrapping).
        let labelText = '';
        if (node.id) {
          const root = node.getRootNode() as Document | ShadowRoot;
          const forLabel = root.querySelector(`label[for="${CSS.escape(node.id)}"]`);
          if (forLabel) labelText = (forLabel.textContent ?? '').trim();
        }
        if (!labelText) {
          const wrapping = node.closest('label');
          if (wrapping) labelText = (wrapping.textContent ?? '').trim();
        }

        return {
          tagName: node.tagName.toLowerCase(),
          id: node.id || undefined,
          classes: Array.from(node.classList),
          textContent: (node.innerText ?? node.textContent ?? '').trim(),
          attributes: attrs,
          anchor: {
            parentTag: parent?.tagName.toLowerCase(),
            parentText,
            siblingTexts,
            ariaLabel: node.getAttribute('aria-label') ?? undefined,
            role: node.getAttribute('role') ?? undefined,
            dataTestId:
              node.getAttribute('data-testid') ??
              node.getAttribute('data-test') ??
              undefined,
            labelText: labelText || undefined,
          },
          pageUrlPattern: location.pathname,
        };
      },
      SIBLING_WINDOW,
      { timeout: this.timeout },
    );
  }

  private toMeta(
    logicalName: string,
    selector: string,
    snap: DomSnapshot,
  ): ElementMetaData {
    return {
      logicalName,
      primarySelector: selector,
      tagName: snap.tagName,
      id: snap.id,
      classes: snap.classes,
      textContent: snap.textContent,
      attributes: snap.attributes,
      anchorContext: snap.anchor,
      capturedAt: new Date().toISOString(),
      pageUrlPattern: snap.pageUrlPattern,
    };
  }
}
