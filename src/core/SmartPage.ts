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
  AnchorContext,
} from '../storage/ElementMetaData';
import { SelfHealingEngine, HealResult, toLocatorString } from '../healing/SelfHealingEngine';
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
    const locator = this.page.locator(primary).first();
    let snap: DomSnapshot | undefined;
    try {
      snap = this.captureMode === 'auto' ? await this.snapshot(locator) : undefined;
      await action(locator);
    } catch (err) {
      if (!this.isInteractionError(err)) throw err;

      const outcome = await this.attemptHeal(logicalName, primary, action);
      outcome.durationMs = Date.now() - startedAt;
      this.reporter.record(outcome);

      if (outcome.strategy === 'failed') {
        // Re-throw a decorated version of the original error so users still
        // see the full Playwright context (including trace), but with the
        // healing diagnostics attached.
        const reason = outcome.reason ?? 'unknown heal failure';
        (err as Error).message =
          `${(err as Error).message}\n[SelfHealing] ${reason}`;
        throw err;
      }
      return;
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
    });

    if (!meta) {
      return fail('No historical metadata for this logical name – nothing to heal from.');
    }

    let domHtml: string;
    try {
      domHtml = await this.page.content();
    } catch (contentErr) {
      return fail(`Unable to read page.content(): ${(contentErr as Error).message}`);
    }

    let result: HealResult;
    try {
      result = this.engine.heal(domHtml, meta);
    } catch (engineErr) {
      return fail(`Healing engine error: ${(engineErr as Error).message}`);
    }

    const candidate = result.candidate;
    if (!result.healed || !candidate) {
      return fail(
        `No DOM candidate met the confidence threshold. ` +
          `Best score=${result.confidence.toFixed(3)} ` +
          `across ${result.candidatesEvaluated} candidates.`,
        result.confidence,
      );
    }

    // Try the CSS healed selector first (with `>> nth=N` when the CSS form
    // also matches look-alikes); if that throws at action time, fall back
    // to the XPath expression the engine produced for the same candidate.
    const cssLocator = toLocatorString(candidate);
    const attempts: Array<{ locatorExpr: string; kind: 'css' | 'xpath' }> = [
      { locatorExpr: cssLocator, kind: 'css' },
      { locatorExpr: `xpath=${candidate.xpath}`, kind: 'xpath' },
    ];
    // Surfaced in the reason so near-ties are visible in the audit trail.
    const runnerUp = result.topCandidates[1]?.score;
    const runnerUpNote = runnerUp === undefined ? '' : ` (runner-up ${runnerUp.toFixed(3)})`;

    let lastError: Error | undefined;
    for (const attempt of attempts) {
      const healedLocator = this.page.locator(attempt.locatorExpr).first();
      let snap: DomSnapshot | undefined;
      try {
        // The fingerprint is re-captured from the healed node's CURRENT DOM
        // state. Without this, anchor context (siblings, label, attributes)
        // stays anchored to the original UI and each additional mutation
        // would score against stale "training data".
        snap = this.captureMode === 'auto' ? await this.snapshot(healedLocator) : undefined;
        await action(healedLocator);
      } catch (retryErr) {
        lastError = retryErr as Error;
        continue;
      }

      if (snap) {
        // Append the broken selector to the rolling audit trail.
        const healedFrom = Array.from(
          new Set([...(meta.healedFrom ?? []), failedSelector]),
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
          `via ${attempt.kind.toUpperCase()} with score ${result.confidence.toFixed(3)}${runnerUpNote}.`,
        durationMs: 0,
        timestamp,
      };
    }

    return fail(
      `Healed selector(s) failed on retry: ${lastError?.message ?? 'unknown'}`,
      result.confidence,
      cssLocator,
    );
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
  // Metadata capture (browser-side evaluation)
  // --------------------------------------------------------------------

  /**
   * Harvest the element's fingerprint in the browser. Waits up to the
   * action timeout for the locator to resolve, so a missing element fails
   * here exactly like the action itself would.
   */
  private async snapshot(locator: Locator): Promise<DomSnapshot> {
    return locator.evaluate(
      (el): DomSnapshot => {
        const node = el as HTMLElement;
        const parent = node.parentElement;

        // Attributes
        const attrs: Record<string, string> = {};
        for (const attr of Array.from(node.attributes)) {
          attrs[attr.name] = attr.value;
        }

        // Sibling texts (non-empty only)
        const siblingTexts: string[] = [];
        if (parent) {
          parent.childNodes.forEach((child) => {
            if (child === node || child.nodeType !== Node.ELEMENT_NODE) return;
            const t = (child as HTMLElement).innerText?.trim();
            if (t) siblingTexts.push(t);
          });
        }

        // Parent's OWN text (exclude descendants).
        let parentText = '';
        if (parent) {
          parent.childNodes.forEach((child) => {
            if (child.nodeType === Node.TEXT_NODE) {
              parentText += ` ${child.textContent?.trim() ?? ''}`;
            }
          });
          parentText = parentText.trim();
        }

        // Associated label (by `for=id` or by wrapping).
        let labelText = '';
        if (node.id) {
          const forLabel = document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
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
      undefined,
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
