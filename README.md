# Playwright Self-Healing Framework

> **Your E2E tests stop breaking when the UI changes.**
>
> A TypeScript-first Playwright framework that intercepts failing locators, scores every node in the live DOM against a semantic fingerprint, and rewrites broken selectors on the fly — deterministically, offline, zero LLM calls.

![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-1.45-2EAD33?logo=playwright&logoColor=white)
![Vitest](https://img.shields.io/badge/Vitest-5.1-6E9F18?logo=vitest&logoColor=white)
![Strict TS](https://img.shields.io/badge/strict%20mode-on-success)
![Tests](https://img.shields.io/badge/35%20unit%20%2B%203%20e2e-passing-success)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## See it heal — in 30 seconds

Same test. Three rewrites of the same page. **Zero maintenance.**

```ts
// The test – written once, never changed
await checkout.fillEmail('alice@example.com');
await checkout.fillCoupon('SAVE10');
await checkout.submit();
```

|                         | `original.html`          | `mutated.html`        | `text-drift.html`   |
| ----------------------- | ------------------------ | --------------------- | ------------------- |
| submit button `id`      | `#submit-order`          | `#btn_a1b2c3d4`       | `#placeOrderBtn`    |
| submit button `class`   | `submit-btn`             | `cta-btn primary-cta` | `cta-btn`           |
| visible text            | `Submit Order`           | `Submit Order`        | **`Place Order`**   |
| `data-testid`           | `checkout-submit`        | _(removed)_           | _(removed)_         |
| email label             | `Email address`          | `Email address`       | **`Email`**         |

Heal report produced by the actual test run in this repo:

```
[HEALED] checkout.submitButton  [data-testid="checkout-submit"] -> #btn_a1b2c3d4    conf 82.0%
[HEALED] checkout.submitButton  #btn_a1b2c3d4                   -> #placeOrderBtn   conf 66.2%
[HEALED] checkout.emailField    #email-field                    -> #emailAddr_9f3a  conf 87.5%
[HEALED] checkout.emailField    #emailAddr_9f3a                 -> #email_q7        conf 81.8%
```

Three DOMs, one test file, six successful heals — and a full JSON audit trail for every decision.

---

## Why this exists

Every E2E suite eventually becomes a **selector maintenance job**. A dev renames an `id`, swaps a CSS framework, or migrates to a new component library — and twelve green tests flip red overnight. Teams respond with:

- **Instrumentation tax** — stamping `data-testid` on every interactive element, forever.
- **Retry inflation** — cranking retries to hide real regressions.
- **Stabilisation sprints** — a recurring line item nobody enjoys.

This project accepts that **selector drift is inevitable** and designs around it instead of paying the tax.

---

## How it works

Just before every interaction (in the default `auto` capture mode), the wrapper snapshots a **semantic fingerprint** of the element, and persists it once the interaction succeeds. Snapshotting first means an action that navigates away or removes its own element is still recorded:

- tag, id, every class, every attribute
- visible text (`normalize-space`)
- the `<label>` that references the element (by `for=` or by wrapping)
- the parent's own text and each non-empty sibling's text

When a later run's primary selector times out, the engine takes over:

1. Serialises the live DOM, inlining every **open shadow root** into its host, and parses it with cheerio, with no browser re-render. The copy is built in an inert document, so component constructors don't re-run and media doesn't load.
2. Scores every candidate node using **six normalised sub-scores in `[0, 1]`**:

   | Signal          | Weight | Why it matters                                                         |
   | --------------- | ------ | ---------------------------------------------------------------------- |
   | Visible text    | 0.45   | Button labels and headings rarely change meaning                       |
   | Anchor context  | 0.20   | `<label>`, parent copy, aria, `data-testid`, sibling topology          |
   | Tag             | 0.10   | Soft penalty if the element was re-tagged (`button` → `a`)             |
   | Attributes      | 0.10   | Ratio of expected attrs still present & similar (ignores id/class noise) |
   | Classes         | 0.10   | Tokenised Jaccard so `cta-btn` ≈ `btn-cta` despite renames             |
   | Id              | 0.05   | Deliberately low — ids churn first                                     |

3. Accepts the top candidate iff its blended score clears the threshold (default `0.6`). If no node with the original tag clears it, the scan widens to every element in `<body>`, since the element may have been re-tagged (`button` → `a`). Ties go to the innermost node, and the runner-up score is recorded in the heal reason.
4. Emits **both** a CSS selector and an XPath, the latter with `normalize-space(text())='...'` for buttons/links/labels, which CSS cannot express. The CSS form is the most stable strategy that is **unique** on the page. If none is unique, it gets a `>> nth=N` suffix so a look-alike element is never used by mistake.
5. **Re-captures** the fingerprint from the healed node, so the next mutation scores against up-to-date data instead of the original snapshot. In `readonly` capture mode nothing is written. The heal still happens, but the store is left untouched.

No LLMs, no API keys, no remote service. Every decision is reproducible and inspectable.

---

## Quick start

Requires **Node.js 22.13 or newer**, the first release with built-in `node:sqlite` unflagged.

```bash
git clone https://github.com/ShantanuVr/playwright-self-healing-framework.git
cd playwright-self-healing-framework
npm install
npm test
```

Expected output:

```
Test Files  2 passed (2)                                           Vitest
     Tests  35 passed (35)  in 266ms

 ✓ 1. Seed run: captures metadata from the original UI             ( 0.6s)
 ✓ 2. Heal run: recovers from full id/class mutation               (12.3s)
 ✓ 3. Text-drift run: recovers when copy ALSO changes              (12.3s)

 3 passed (26.5s)                                                   Playwright
```

The demo boots a local `http-server` on port `5555`, seeds metadata from `/original.html`, heals on `/mutated.html`, then heals again on `/text-drift.html`.

---

## Storage backends

| Backend | Selected by | Notes |
| ------- | ----------- | ----- |
| JSON (default) | any other path, default `storage/element-metadata.json` | Human-readable and diffable in PRs. **Single writer**, so run one Playwright worker. |
| SQLite | a path ending in `.db` or `.sqlite` | Built on Node's `node:sqlite`, no extra dependency. Safe for **parallel workers**: reads hit the database directly, so workers see each other's heals, and every upsert is a short `BEGIN IMMEDIATE` transaction under WAL with a 5 s busy timeout. |

The demo fixtures read `SELFHEAL_STORE_PATH`:

```bash
SELFHEAL_STORE_PATH=storage/element-metadata.db npm run test:e2e
```

In your own fixtures, construct `new SqliteMetadataStore(path)`, call `load()` before use and `close()` at teardown. Node still labels `node:sqlite` experimental and prints a one-time `ExperimentalWarning`. It is still a local file, not a shared remote backend.

---

## Architecture

```
  +-------------+        +--------------------+        +---------------------+
  |  Test Case  |------> |     SmartPage      |------> |   Playwright Page   |
  +-------------+        +--------------------+        +---------------------+
                                 |  ^                            |
                            fails|  |healed                       |DOM
                                 v  |                            v
                          +-----------------+           +-----------------+
                          |SelfHealingEngine|<----------| page.content()  |
                          +-----------------+           +-----------------+
                                 |  ^
                                 v  |
                          +-----------------+
                          | IMetadataStore  |  (JSON today, SQLite tomorrow)
                          +-----------------+
                                 |
                                 v
                          +-----------------+
                          |  StateReporter  |  (console + reports/*.json)
                          +-----------------+
```

Storage sits behind the `IMetadataStore` interface. The engine and reporter are plain classes injected into `SmartPage`, so you can subclass or replace either one without touching the orchestration code.

---

## Feature highlights

- **Zero-LLM, deterministic healing.** Every heal is replayable and inspectable.
- **Dual selector output.** CSS first; XPath fallback retried at click time if CSS becomes ambiguous.
- **Shadow DOM aware.** Open shadow roots are scanned and healed into. When a selector matches several elements, the `>> nth=N` index is mapped into Playwright's own piercing order, so the element that was scored is the one that gets clicked.
- **Strict TypeScript.** `"strict": true`, no `any` escapes, no unused locals/parameters.
- **SOLID decomposition.** `IMetadataStore` abstracts storage. `SelfHealingEngine` and `StateReporter` are injected collaborators, so each can be subclassed or swapped.
- **POM-friendly.** Drop into any Page Object suite — supply logical names and optional hints, nothing else.
- **Full audit trail.** Every interaction logged to console + persisted as JSON with per-signal breakdown, confidence, before/after selector.
- **35 unit tests and 3 browser scenarios, < 30 s total run.** Engine correctness is not trust-me-bro.

---

## How it compares

|                                   | Playwright as-is | `data-testid` everywhere | Self-Healing Framework     |
| --------------------------------- | ---------------- | ------------------------ | -------------------------- |
| Tests break on UI refactor        | always           | sometimes                | only below confidence floor |
| Requires dev instrumentation      | no               | yes, perpetually         | no                         |
| Flake rate from selector drift    | high             | medium                   | ~ 0                        |
| Per-run audit artifact            | none             | none                     | JSON heal report           |
| External dependency / API key     | none             | none                     | none                       |
| Setup cost                        | minimal          | ongoing                  | one-off                    |

---

## Project layout

```
src/
├── core/SmartPage.ts             Custom Playwright action wrapper
├── healing/SelfHealingEngine.ts  Weighted DOM-scoring engine (+ XPath builder)
├── healing/SimilarityUtils.ts    Levenshtein, Jaccard, tokeniser
├── healing/*.test.ts             Vitest unit tests (pure logic, no browser)
├── storage/ElementMetaData.ts    Persistence types
├── storage/IMetadataStore.ts     Storage abstraction (SOLID-DIP)
├── storage/JsonMetadataStore.ts  Default JSON-file backend
├── storage/SqliteMetadataStore.ts SQLite backend (node:sqlite, parallel-safe)
└── reporting/StateReporter.ts    Console summary + JSON report
pages/CheckoutPage.ts             Sample Page Object
mock-ui/{original,mutated,text-drift}.html  Fixture UIs with drifting selectors
tests/self-healing.spec.ts        Seed -> Heal -> Text-Drift e2e demo
```

---

## Extending

Everything is built around interfaces, so you can substitute any component without touching the others:

```ts
// Add a shared remote backend: Redis / DynamoDB / Postgres
class RedisStore implements IMetadataStore { /* ... */ }

// Subclass the engine to add embedding-based similarity
class SemanticEngine extends SelfHealingEngine { /* ... */ }

// Tune weights per page type — forms need more anchor signal, buttons more text
new SelfHealingEngine({
  weights: { text: 0.35, anchor: 0.35, classes: 0.10, tag: 0.10, attributes: 0.05, id: 0.05 },
  threshold: 0.55,
});
```

---

## Roadmap

- [x] **Phase 1** — JSON store, 6-signal heuristic, CSS selector heal, mock UI demo
- [x] **Phase 2** — XPath fallback, fresh-on-heal recapture, full Vitest harness, text-drift scenario
- [ ] **Phase 3**
  - [x] Shadow DOM scanning (open shadow roots)
  - [x] SQLite backend (`node:sqlite`, parallel-worker safe)
  - [ ] Healing-replay CLI
- [ ] **Phase 4** — Confidence telemetry exporter for Grafana / Datadog
- [ ] **Phase 5** — Optional embedding-based similarity for semantic drift beyond Levenshtein

---

## Known limitations (honesty section)

- Closed shadow roots and cross-origin iframes are not scanned. Open shadow roots are: the CSS heal pierces them, but the XPath fallback cannot reach shadow content, because XPath does not pierce shadow roots.
- Slotted light-DOM content is scored in its light-DOM position, after the host's shadow children, rather than distributed into its `<slot>`.
- Metadata lives on disk per checkout, as JSON or SQLite. A shared remote backend such as Redis is not provided.
- The JSON store is single-writer. Run one Playwright worker (the default config does), or use the SQLite backend for parallel workers.
- The JSON store writes atomically (temp file + rename). If it ever finds a corrupt file, it moves it aside as `*.corrupt-<timestamp>` instead of overwriting it.
- Re-capture on heal trusts the first accepted candidate. A post-test verification hook would close the false-positive window.
- Elements without visible text, such as form inputs, all score a full 1.0 on the text signal against each other. A look-alike field can therefore clear the threshold if the real one disappears; in the demo, the coupon input scores 0.70 against the email fingerprint. Every heal reason records the runner-up score so these near-ties show up. A proper fix re-weights uninformative signals, and that needs a mutation benchmark first.

---

## Contributing

Issues and pull requests are very welcome. The two hottest areas:

1. **New storage backends.** Implement `IMetadataStore` — 5 methods, pure interface.
2. **Scoring heuristics.** Drop a subclass of `SelfHealingEngine` that beats the default on a shared mutation benchmark.

Iterate fast with `npm run test:unit:watch` — the engine is fully testable without a browser.

---

## License

[MIT](./LICENSE). Free for commercial and personal use.

---

_If this saves your team a single stabilisation sprint, a GitHub star would mean a lot._
