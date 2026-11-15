/**
 * @file SimilarityUtils.ts
 * @description Pure, stateless string/token similarity helpers used by the
 *              self-healing scoring algorithm. No external dependencies and
 *              no I/O – safe to unit-test in isolation.
 */

export class SimilarityUtils {
  /**
   * Classical Levenshtein edit distance. Iterative, two-row DP; O(n*m) time,
   * O(min(n,m)) space. Returns the minimum single-character edit count to
   * turn `a` into `b`.
   */
  public static levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    // Ensure `b` is the shorter string to minimise memory use.
    if (a.length < b.length) {
      const tmp = a;
      a = b;
      b = tmp;
    }

    const prev: number[] = new Array(b.length + 1);
    const curr: number[] = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;

    for (let i = 1; i <= a.length; i++) {
      curr[0] = i;
      const aCode = a.charCodeAt(i - 1);
      for (let j = 1; j <= b.length; j++) {
        const cost = aCode === b.charCodeAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(
          curr[j - 1] + 1,     // insertion
          prev[j] + 1,         // deletion
          prev[j - 1] + cost,  // substitution
        );
      }
      for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
    }
    return prev[b.length];
  }

  /**
   * Normalised Levenshtein-based similarity in [0, 1] where 1 = identical.
   * Both inputs are trimmed and lower-cased for robustness against casing
   * and whitespace drift.
   */
  public static stringSimilarity(a: string | undefined, b: string | undefined): number {
    const left = (a ?? '').trim().toLowerCase();
    const right = (b ?? '').trim().toLowerCase();
    if (!left && !right) return 1;
    if (!left || !right) return 0;
    const distance = this.levenshtein(left, right);
    const longest = Math.max(left.length, right.length);
    return 1 - distance / longest;
  }

  /**
   * Jaccard similarity over two sets of tokens: |A ∩ B| / |A ∪ B|.
   * Returns 1 if both sides are empty (semantic "no information – neutral").
   */
  public static jaccard(a: string[], b: string[]): number {
    const setA = new Set(a.map(t => t.toLowerCase()).filter(Boolean));
    const setB = new Set(b.map(t => t.toLowerCase()).filter(Boolean));
    if (setA.size === 0 && setB.size === 0) return 1;
    if (setA.size === 0 || setB.size === 0) return 0;

    let intersect = 0;
    for (const token of setA) if (setB.has(token)) intersect++;
    const union = setA.size + setB.size - intersect;
    return union === 0 ? 0 : intersect / union;
  }

  /**
   * Cosine similarity of two vectors, clamped to [0, 1] – for our purposes
   * a negative cosine is simply "unrelated". Returns 0 for empty, all-zero
   * or mismatched-length vectors.
   */
  public static cosine(a: number[], b: number[]): number {
    if (a.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return Math.min(1, Math.max(0, dot / Math.sqrt(normA * normB)));
  }

  /**
   * Lightweight tokeniser: splits on whitespace and common CSS/HTML
   * separators (`- _ / .`). Drops empty fragments. Intentionally avoids a
   * heavyweight NLP dependency – this is enough to compare class lists,
   * kebab-/snake-cased ids, and short text snippets.
   */
  public static tokenize(value: string | undefined): string[] {
    if (!value) return [];
    return value
      .split(/[\s\-_/.:]+/)
      .map(t => t.trim().toLowerCase())
      .filter(Boolean);
  }
}
