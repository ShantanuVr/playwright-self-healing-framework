/**
 * @file StateReporter.ts
 * @description Collects {@link HealingOutcome} entries across a test run
 *              and produces both a human-readable console summary and a
 *              machine-readable JSON artifact persisted under `reports/`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { HealingOutcome } from '../storage/ElementMetaData';

export class StateReporter {
  private readonly outcomes: HealingOutcome[] = [];
  private readonly reportDir: string;

  constructor(reportDir: string = path.resolve('reports')) {
    this.reportDir = reportDir;
  }

  public record(outcome: HealingOutcome): void {
    this.outcomes.push(outcome);
  }

  /** Read-only view of all collected outcomes. */
  public get entries(): readonly HealingOutcome[] {
    return this.outcomes;
  }

  /**
   * Renders an aligned, colour-free textual report. Kept intentionally
   * plain so it shows up correctly in CI log viewers.
   */
  public summary(): string {
    const total = this.outcomes.length;
    const healed = this.outcomes.filter(o => o.strategy === 'healed').length;
    const failed = this.outcomes.filter(o => o.strategy === 'failed').length;
    const exact = total - healed - failed;

    const lines: string[] = [
      '',
      '================================================================',
      '                 SELF-HEALING TEST RUN REPORT                   ',
      '================================================================',
      `Total Interactions : ${total}`,
      `Exact Matches      : ${exact}`,
      `Healed Locators    : ${healed}`,
      `Unrecoverable      : ${failed}`,
      '----------------------------------------------------------------',
    ];

    if (healed === 0 && failed === 0) {
      lines.push('(no locator required healing)');
    } else {
      this.outcomes
        .filter(o => o.strategy !== 'exact')
        .forEach(o => lines.push(this.formatOutcome(o)));
    }

    lines.push('================================================================');
    return lines.join('\n');
  }

  private formatOutcome(o: HealingOutcome): string {
    const header = `[${o.strategy.toUpperCase()}] ${o.logicalName}`;
    const fromLine = `   from : ${o.originalSelector}`;
    const toLine = o.healedSelector ? `   to   : ${o.healedSelector}` : '';
    const confLine = `   conf : ${(o.confidence * 100).toFixed(1)}%`;
    const reasonLine = o.reason ? `   why  : ${o.reason}` : '';
    return [header, fromLine, toLine, confLine, reasonLine]
      .filter(Boolean)
      .join('\n');
  }

  /** Persists the run to `${reportDir}/<fileName>`. Returns the full path. */
  public async writeToDisk(
    fileName: string = `heal-report-${Date.now()}.json`,
  ): Promise<string> {
    await fs.promises.mkdir(this.reportDir, { recursive: true });
    const filePath = path.join(this.reportDir, fileName);
    const payload = {
      generatedAt: new Date().toISOString(),
      totals: {
        total: this.outcomes.length,
        healed: this.outcomes.filter(o => o.strategy === 'healed').length,
        failed: this.outcomes.filter(o => o.strategy === 'failed').length,
        exact: this.outcomes.filter(o => o.strategy === 'exact').length,
      },
      outcomes: this.outcomes,
    };
    await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    return filePath;
  }

  /** Resets in-memory state (useful between test files). */
  public reset(): void {
    this.outcomes.length = 0;
  }
}
