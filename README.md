# Playwright Self-Healing Framework

> **Your E2E tests stop breaking when the UI changes.**
>
> A TypeScript-first Playwright framework that intercepts failing locators, scores every node in the live DOM against a semantic fingerprint, and rewrites broken selectors on the fly — deterministically, offline, zero LLM calls.

![CI](https://github.com/ShantanuVr/playwright-self-healing-framework/actions/workflows/ci.yml/badge.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-1.59-2EAD33?logo=playwright&logoColor=white)
![Vitest](https://img.shields.io/badge/Vitest-5.1-6E9F18?logo=vitest&logoColor=white)
![Strict TS](https://img.shields.io/badge/strict%20mode-on-success)
![Tests](https://img.shields.io/badge/122%20unit%20%2B%208%20e2e-passing-success)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## See it heal — in 30 seconds

Same test. Four rewrites of the same page. **Zero maintenance.**

```ts
// The test – written once, never changed
await checkout.fillEmail('alice@example.com');
await checkout.fillCoupon('SAVE10');
await checkout.submit();
```

|                         | `original.html`          | `mutated.html`        | `text-drift.html`   | `shadow-dom.html`              |
| ----------------------- | ------------------------ | --------------------- | ------------------- | ------------------------------ |
| submit button `id`      | `#submit-order`          | `#btn_a1b2c3d4`       | `#placeOrderBtn`    | `#place_k4`                    |
| submit button `class`   | `submit-btn`             | `cta-btn primary-cta` | `cta-btn`           | `cta-btn`                      |
| visible text            | `Submit Order`           | `Submit Order`        | **`Place Order`**   | `Place Order`                  |
| `data-testid`           | `checkout-submit`        | _(removed)_           | _(removed)_         | _(removed)_                    |
| email label             | `Email address`          | `Email address`       | **`Email`**         | `Email`                        |
| rendered in             | light DOM                | light DOM             | light DOM           | **a web component's shadow root** |

Heal report produced by the actual test run in this repo:

```
[HEALED] checkout.submitButton  [data-testid="checkout-submit"] -> #btn_a1b2c3d4    conf 82.0%
[HEALED] checkout.submitButton  #btn_a1b2c3d4                   -> #placeOrderBtn   conf 66.2%
[HEALED] checkout.emailField    #email-field                    -> #emailAddr_9f3a  conf 87.5%
[HEALED] checkout.emailField    #emailAddr_9f3a                 -> #email_q7        conf 81.8%
[HEALED] checkout.submitButton  #placeOrderBtn                  -> #place_k4        conf 96.9%   (inside a shadow root)
```

Four DOMs, one test file, nine successful heals, and a full JSON audit trail for every decision.

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
- the parent's own text and the text of the nearest five siblings on each side

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
4. Emits **both** a CSS selector and an XPath, the latter with `normalize-space(text())='...'` for buttons/links/labels, which CSS cannot express. The CSS form is the most stable strategy that is **unique** on the page. If none is unique, it gets a `>> nth=N` suffix so a look-alike element is never used by mistake. Such an index follows DOM order, so later runs re-check it against the fingerprint and re-heal if rows moved. The XPath fallback is only used when it matches exactly one element.
5. **Re-captures** the fingerprint from the healed node, so the next mutation scores against up-to-date data instead of the original snapshot. In `readonly` capture mode nothing is written. The heal still happens, but the store is left untouched.

By default: no LLMs, no API keys, no remote service. Every decision is reproducible and inspectable. Embedding similarity is strictly opt-in (see below).

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
Test Files  6 passed (6)                                           Vitest
     Tests  122 passed (122)

 ✓ Regressions › an action that removes its own element runs exactly once  ( 0.1s)
 ✓ Regressions › readonly capture mode heals without writing the store     ( 1.2s)
 ✓ Regressions › an ambiguous XPath fallback is never used                 ( 2.1s)
 ✓ Regressions › a positional selector that drifted ... is re-healed       ( 1.1s)
 ✓ 1. Seed run: captures metadata from the original UI                      ( 0.1s)
 ✓ 2. Heal run: recovers from full id/class mutation                        (12.2s)
 ✓ 3. Text-drift run: recovers when copy ALSO changes                       (12.2s)
 ✓ 4. Shadow DOM run: heals into an open shadow root                        (12.2s)

 8 passed (41.7s)                                                            Playwright
```

The demo boots a tiny built-in static server (`scripts/serve-static.js`) on port `5555`, seeds metadata from `/original.html`, heals on `/mutated.html`, heals again on `/text-drift.html`, then follows the form into a web component's shadow root on `/shadow-dom.html`. Each heal takes about 12 s, almost all of it the 4 s action timeout expiring once per broken selector before healing starts.

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

## Healing replay CLI

Every heal attempt in a report (`reports/*.json`) records what the engine saw: the stored fingerprint and the serialised DOM. `replay` re-runs the engine on that data offline, without a browser. You can see how a scoring or config change would have decided past heals:

```bash
npm run selfheal -- replay reports/                    # does today's engine still agree?
npm run selfheal -- replay reports/ --threshold 0.7    # would a stricter threshold refuse a heal?
npm run selfheal -- replay reports/heal-2-*.json --weights '{"text":0.35,"anchor":0.35}' --top 3
```

```
same     checkout.submitButton  (heal-3-Text-drift-run-...json)
   recorded : HEALED 0.662 -> #placeOrderBtn
   replayed : HEALED 0.662 -> #placeOrderBtn
     1. 0.662  #placeOrderBtn  text=0.50 tag=1.00 id=0.00 classes=0.67 attributes=1.00 anchor=0.85
     2. 0.437  #abortBtn  text=0.08 tag=1.00 id=0.08 classes=0.25 attributes=1.00 anchor=0.85
```

Exit codes:
- `0`: every decision is unchanged.
- `1`: at least one decision changed. This makes it usable as a regression gate for scoring changes.
- `2`: bad arguments or unreadable reports.

`npm run selfheal` compiles with `tsc` first. Use `npm run build` and `node dist/src/cli/selfheal.js` to skip the rebuild.

> **Reports contain page HTML.** Every heal attempt includes the DOM the engine scored. Reports stay local (`reports/` is gitignored) and the framework never sends them anywhere. Treat them like any other test artifact that may contain page content.

---

## Confidence telemetry (Grafana / Datadog)

`selfheal export` turns heal reports into two gauges. Every backend gets the same numbers:

| Metric (Prometheus / Datadog) | Labels / tags | Value |
| ----------------------------- | ------------- | ----- |
| `selfheal_interactions` / `selfheal.interactions` | `strategy` (`exact`, `healed`, `failed`) | Interactions in the exported reports |
| `selfheal_heal_confidence` / `selfheal.heal.confidence` | `logical_name`, `strategy` | Lowest confidence among that element's non-exact outcomes, i.e. the weakest heal |

Alert when `selfheal_heal_confidence` drifts toward your threshold. That means an element is about to stop healing, so it's time to update its selector deliberately. Only `strategy` and `logical_name` ever become labels. Cardinality stays bounded, and no selector, page text or DOM leaves the machine.

```bash
npm run clean && npm run test:e2e   # export aggregates exactly the files you pass, so start from one run's reports

npm run selfheal -- export reports/                                                # dry run: Prometheus text on stdout
npm run selfheal -- export reports/ --pushgateway http://localhost:9091 --job checkout-e2e   # Prometheus → Grafana
npm run selfheal -- export reports/ --prometheus-file /var/lib/node_exporter/textfile/selfheal.prom
DD_API_KEY=... DD_SITE=datadoghq.eu npm run selfheal -- export reports/ --datadog
```

- **Pushgateway.**
  - `PUT /metrics/job@base64/<job>` replaces the job's group on every push.
  - The job name is base64-encoded in the URL, so any name works.
  - No timestamps are sent, because the Pushgateway rejects them.
- **File.** The exposition is written atomically (temp file + rename), so node_exporter's textfile collector never reads a partial file.
- **Datadog.**
  - Metrics go through API v2 `POST /api/v2/series` as gauges, so no Agent is needed in CI.
  - Points are stamped with the export time, because Datadog rejects points older than one hour.
  - The API key comes from `DD_API_KEY` only, never from a flag.
  - `DD_SITE` must be a Datadog domain, so a typo can't send your key elsewhere.
  - Datadog lowercases tag values.
- **Programmatic use.** Call `new PrometheusExporter({ pushgatewayUrl }).export(outcomes)` or `new DatadogExporter({ apiKey }).export(outcomes)`, for example from a Playwright `globalTeardown`. Both implement `ITelemetryExporter`.
- **Exit codes:**
  - `0`: exported;
  - `1`: an export failed (the other targets still run);
  - `2`: bad arguments or reports.

---

## Semantic similarity (optional embeddings)

Levenshtein sees "Submit Order" → "Buy now" as almost unrelated. An embedding model sees two ways of saying the same thing. Plug one in and the **text signal** becomes a blend of the two:

```
similarity = max(0, (cosine(embedding(stored text), embedding(candidate text)) − b) / (1 − b))
text       = (1 − w) · levenshtein + w · similarity
```

```ts
import { SelfHealingEngine } from './src/healing/SelfHealingEngine';
import { HttpEmbeddingProvider } from './src/healing/HttpEmbeddingProvider';

const engine = new SelfHealingEngine({
  embeddings: {
    // Any OpenAI-compatible /embeddings endpoint: a local Ollama keeps everything offline.
    provider: new HttpEmbeddingProvider({ url: 'http://localhost:11434/v1/embeddings', model: 'nomic-embed-text' }),
    weight: 0.5,   // share of the text signal from embeddings, [0, 1]
    baseline: 0.5, // cosine at or below which texts count as unrelated, [0, 1)
  },
});
```

The demo fixtures switch it on via env: `SELFHEAL_EMBEDDINGS_URL`, `SELFHEAL_EMBEDDINGS_MODEL` (default `nomic-embed-text`), `SELFHEAL_EMBEDDINGS_API_KEY`, `SELFHEAL_EMBEDDINGS_WEIGHT` and `SELFHEAL_EMBEDDINGS_BASELINE`.

- **Off by default.** Without a provider, the engine makes no network calls, and scores are identical to the lexical engine.
- **Failure-safe.**
  - If the provider errors or returns malformed vectors, the heal continues on lexical scores.
  - The warning is recorded in the heal reason.
- **Bounded cost.**
  - One `embed()` call per heal, covering the stored text plus the unique texts of the top 50 lexical candidates (each clipped to 2,000 characters).
  - Elements without visible text, such as inputs, never trigger a call.
- **Baseline matters.** Real models give *unrelated* short texts a cosine of roughly 0.3–0.6. Blending raw cosine would lift every wrong candidate toward the threshold, so similarity is rescaled above `baseline` (default `0.5`). Lower it for models with low baseline similarity, such as OpenAI `text-embedding-3` or MiniLM, and keep or raise it for high ones such as nomic or BGE.
- **Embeddings run before the scan widens.** A reworded element is blended within the same-tag pass, and the scan widens only if that still fails.
- **Weight matters.** With the default `0.5`, a rewrite as heavy as "Submit Order" → "Buy now" is lifted (0.38 → 0.57 in our checks) but may not clear the 0.6 threshold on its own. Raising `w` to 0.7–0.8 heals it. Tune it on your own UI before relying on it.
- **Privacy.** Candidate texts are sent to the endpoint you configure. Point it at a local model if page copy must not leave the machine.
- **Replay.** Embedding-assisted decisions are marked in reports. `selfheal replay` is lexical-only, so it labels them `semantic` instead of flagging them as changed.
- **Interface.** Anything implementing `IEmbeddingProvider` (`embed(texts) → number[][]`) can be plugged in.

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

- **Zero-LLM, deterministic healing by default.** Every heal is replayable and inspectable. Semantic (embedding) similarity is an opt-in plug-in.
- **Dual selector output.** CSS first. If the CSS action fails, the XPath is retried, but only when it matches exactly one element.
- **Shadow DOM aware.** Open shadow roots are scanned and healed into. When a selector matches several elements, the `>> nth=N` index is mapped into Playwright's own piercing order, so the element that was scored is the one that gets clicked.
- **Strict TypeScript.** `"strict": true`, no `any` escapes, no unused locals/parameters.
- **SOLID decomposition.** `IMetadataStore` abstracts storage. `SelfHealingEngine` and `StateReporter` are injected collaborators, so each can be subclassed or swapped.
- **POM-friendly.** Drop into any Page Object suite — supply logical names and optional hints, nothing else.
- **Full audit trail.** Every interaction logged to console + persisted as JSON with per-signal breakdown, confidence, before/after selector.
- **122 unit tests and 8 browser scenarios.** CI runs them on Node 22 and 24, against both storage backends. Engine correctness is not trust-me-bro.

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
├── healing/SimilarityUtils.ts    Levenshtein, Jaccard, cosine, tokeniser
├── healing/*EmbeddingProvider.ts Optional semantic similarity (OpenAI-compatible HTTP)
├── storage/ElementMetaData.ts    Persistence types
├── storage/IMetadataStore.ts     Storage abstraction (SOLID-DIP)
├── storage/JsonMetadataStore.ts  Default JSON-file backend
├── storage/SqliteMetadataStore.ts SQLite backend (node:sqlite, parallel-safe)
├── cli/selfheal.ts               `replay` and `export` CLI over heal reports
├── telemetry/*Exporter.ts        Prometheus and Datadog confidence exporters
├── reporting/StateReporter.ts    Console summary + JSON report
└── **/*.test.ts                  Vitest unit tests (no browser)
pages/CheckoutPage.ts             Sample Page Object
mock-ui/{original,mutated,text-drift,shadow-dom}.html  Fixture UIs with drifting selectors
mock-ui/self-removing.html        Regression fixture (button that replaces itself)
tests/self-healing.spec.ts        Seed -> Heal -> Text-Drift -> Shadow DOM e2e demo
tests/regressions.spec.ts         Browser regression guards
scripts/serve-static.js           Built-in static server for the mock UI (e2e)
.github/workflows/ci.yml          Typecheck, unit, e2e (JSON + SQLite), build
```

---

## Extending

Everything is built around interfaces, so you can substitute any component without touching the others:

```ts
// Add a shared remote backend: Redis / DynamoDB / Postgres
class RedisStore implements IMetadataStore { /* ... */ }

// Plug in any embedding model (see "Semantic similarity" below)
class MyEmbeddings implements IEmbeddingProvider { async embed(texts: string[]) { /* ... */ } }

// heal() is async: it may await an embedding provider
const result = await new SelfHealingEngine().heal(domHtml, storedMeta);

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
- [x] **Phase 3**
  - [x] Shadow DOM scanning (open shadow roots)
  - [x] SQLite backend (`node:sqlite`, parallel-worker safe)
  - [x] Healing-replay CLI (`npm run selfheal -- replay reports/`)
- [x] **Phase 4**: Confidence telemetry exporters for Grafana (Prometheus Pushgateway / textfile) and Datadog (API v2)
- [x] **Phase 5**: Optional embedding-based similarity for semantic drift beyond Levenshtein (any OpenAI-compatible endpoint, including a local Ollama)

---

## Known limitations (honesty section)

- Closed shadow roots and cross-origin iframes are not scanned. Open shadow roots are: the CSS heal pierces them, but the XPath fallback cannot reach shadow content, because XPath does not pierce shadow roots.
- Slotted light-DOM content is scored in its light-DOM position, after the host's shadow children, rather than distributed into its `<slot>`.
- The flattened DOM is re-parsed with HTML repair rules. Shadow content the parser would restructure, such as block elements inside a `<p>` host or custom elements in table context, scores with shifted parent and sibling context.
- Elements that never get a unique selector are stored by index (`>> nth=N`). Each run re-checks that index against the fingerprint, which costs one extra DOM read for those elements only.
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
