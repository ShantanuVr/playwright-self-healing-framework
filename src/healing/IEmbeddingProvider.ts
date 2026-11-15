/**
 * @file IEmbeddingProvider.ts
 * @description Optional semantic-similarity backend (Phase 5). When one is
 *              configured, the engine blends the cosine similarity of these
 *              vectors into its text signal, so "Submit Order" can still
 *              match "Place order" or "Buy now". Without one, the engine
 *              stays purely lexical, offline and deterministic.
 */

export interface IEmbeddingProvider {
  /** One vector per input text, in input order. Inputs are never empty. */
  embed(texts: string[]): Promise<number[][]>;
}
