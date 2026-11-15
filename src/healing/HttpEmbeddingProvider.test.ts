/**
 * @file HttpEmbeddingProvider.test.ts
 * @description Wire-format tests for the OpenAI-compatible embeddings client.
 *              `fetch` is stubbed, so no network is touched.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpEmbeddingProvider } from './HttpEmbeddingProvider';

const URL_ = 'http://localhost:11434/v1/embeddings';

const respond = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe('HttpEmbeddingProvider', () => {
  it('posts {model, input} as JSON with a bearer token when an API key is set', async () => {
    const fetchMock = respond({ data: [{ index: 0, embedding: [1, 2] }] });
    vi.stubGlobal('fetch', fetchMock);
    await new HttpEmbeddingProvider({ url: URL_, model: 'nomic-embed-text', apiKey: 'sk-1' }).embed(['Pay']);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL_);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', Authorization: 'Bearer sk-1' });
    expect(JSON.parse(String(init.body))).toEqual({ model: 'nomic-embed-text', input: ['Pay'] });
  });

  it('sends no Authorization header without an API key (e.g. local Ollama)', async () => {
    const fetchMock = respond({ data: [{ index: 0, embedding: [1] }] });
    vi.stubGlobal('fetch', fetchMock);
    await new HttpEmbeddingProvider({ url: URL_, model: 'm' }).embed(['a']);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('places vectors by `index`, whatever order the server returns', async () => {
    vi.stubGlobal('fetch', respond({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }));
    const vectors = await new HttpEmbeddingProvider({ url: URL_, model: 'm' }).embed(['first', 'second']);
    expect(vectors).toEqual([[1, 0], [0, 1]]);
  });

  it('surfaces HTTP errors with the status code', async () => {
    vi.stubGlobal('fetch', respond('model "nope" not found', 404));
    await expect(new HttpEmbeddingProvider({ url: URL_, model: 'nope' }).embed(['a'])).rejects.toThrow(/HTTP 404.*not found/);
  });

  it.each([
    ['a missing data array', { object: 'list' }],
    ['the wrong number of items', { data: [] }],
    ['an out-of-range index', { data: [{ index: 3, embedding: [1] }] }],
    ['a duplicated index', { data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] }],
    ['a non-array embedding', { data: [{ index: 0, embedding: 'x' }] }],
  ])('rejects a response with %s', async (_label, body) => {
    vi.stubGlobal('fetch', respond(body));
    const texts = (body as { data?: unknown[] }).data?.length === 2 ? ['a', 'b'] : ['a'];
    await expect(new HttpEmbeddingProvider({ url: URL_, model: 'm' }).embed(texts)).rejects.toThrow(/Malformed embeddings response/);
  });

  it('validates its options', () => {
    expect(() => new HttpEmbeddingProvider({ url: 'file:///etc/passwd', model: 'm' })).toThrow(/http\(s\) URL/);
    expect(() => new HttpEmbeddingProvider({ url: 'not a url', model: 'm' })).toThrow(/http\(s\) URL/);
    expect(() => new HttpEmbeddingProvider({ url: URL_, model: '' })).toThrow(/model is required/);
  });
});
