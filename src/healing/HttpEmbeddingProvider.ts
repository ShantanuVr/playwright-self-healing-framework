/**
 * @file HttpEmbeddingProvider.ts
 * @description {@link IEmbeddingProvider} for any OpenAI-compatible
 *              `/embeddings` endpoint – OpenAI, a local Ollama
 *              (`http://localhost:11434/v1/embeddings`, fully offline),
 *              LM Studio, vLLM, … – using nothing but `fetch`.
 */

import { IEmbeddingProvider } from './IEmbeddingProvider';

export interface HttpEmbeddingProviderOptions {
  /** Full endpoint URL, e.g. `http://localhost:11434/v1/embeddings`. */
  url: string;
  /** Embedding model id, e.g. `nomic-embed-text` or `text-embedding-3-small`. */
  model: string;
  /** Sent as `Authorization: Bearer <apiKey>` when set. */
  apiKey?: string;
}

// Generous: a local model may still be loading on the first request.
const REQUEST_TIMEOUT_MS = 30_000;

export class HttpEmbeddingProvider implements IEmbeddingProvider {
  private readonly options: HttpEmbeddingProviderOptions;

  constructor(options: HttpEmbeddingProviderOptions) {
    let protocol = '';
    try {
      protocol = new URL(options.url).protocol;
    } catch {
      // reported below
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error(`[HttpEmbeddingProvider] url must be an http(s) URL, got "${options.url}"`);
    }
    if (!options.model) throw new Error('[HttpEmbeddingProvider] model is required.');
    this.options = options;
  }

  public async embed(texts: string[]): Promise<number[][]> {
    const { url, model, apiKey } = this.options;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Embedding request failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }

    const data = ((await res.json()) as { data?: unknown } | null)?.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error(`Malformed embeddings response: expected ${texts.length} items in "data".`);
    }
    // Items carry their input position; place each one by `index`.
    const vectors: number[][] = new Array(texts.length);
    for (const item of data as Array<{ embedding?: unknown; index?: unknown }>) {
      const index = item?.index;
      if (
        typeof index !== 'number' || !Number.isInteger(index) ||
        index < 0 || index >= texts.length || vectors[index] !== undefined ||
        !Array.isArray(item.embedding)
      ) {
        throw new Error('Malformed embeddings response: bad "index" or "embedding".');
      }
      vectors[index] = item.embedding as number[];
    }
    return vectors;
  }
}
