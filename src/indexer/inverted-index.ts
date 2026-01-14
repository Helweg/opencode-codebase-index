import * as fs from "fs";
import * as path from "path";

interface InvertedIndexData {
  termToChunks: Record<string, string[]>;
  chunkTokens: Record<string, Record<string, number>>;
}

export class InvertedIndex {
  private indexPath: string;
  private termToChunks: Map<string, Set<string>> = new Map();
  private chunkTokens: Map<string, Map<string, number>> = new Map();

  constructor(indexPath: string) {
    this.indexPath = path.join(indexPath, "inverted-index.json");
  }

  load(): void {
    if (!fs.existsSync(this.indexPath)) {
      return;
    }

    try {
      const content = fs.readFileSync(this.indexPath, "utf-8");
      const data = JSON.parse(content) as InvertedIndexData;

      for (const [term, chunkIds] of Object.entries(data.termToChunks)) {
        this.termToChunks.set(term, new Set(chunkIds));
      }

      for (const [chunkId, tokens] of Object.entries(data.chunkTokens)) {
        this.chunkTokens.set(chunkId, new Map(Object.entries(tokens)));
      }
    } catch {
      this.termToChunks.clear();
      this.chunkTokens.clear();
    }
  }

  save(): void {
    const data: InvertedIndexData = {
      termToChunks: {},
      chunkTokens: {},
    };

    for (const [term, chunkIds] of this.termToChunks) {
      data.termToChunks[term] = Array.from(chunkIds);
    }

    for (const [chunkId, tokens] of this.chunkTokens) {
      data.chunkTokens[chunkId] = Object.fromEntries(tokens);
    }

    fs.writeFileSync(this.indexPath, JSON.stringify(data));
  }

  addChunk(chunkId: string, content: string): void {
    const tokens = this.tokenize(content);
    const termFreq = new Map<string, number>();

    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);

      const chunks = this.termToChunks.get(token) || new Set();
      chunks.add(chunkId);
      this.termToChunks.set(token, chunks);
    }

    this.chunkTokens.set(chunkId, termFreq);
  }

  removeChunk(chunkId: string): void {
    const tokens = this.chunkTokens.get(chunkId);
    if (!tokens) return;

    for (const token of tokens.keys()) {
      const chunks = this.termToChunks.get(token);
      if (chunks) {
        chunks.delete(chunkId);
        if (chunks.size === 0) {
          this.termToChunks.delete(token);
        }
      }
    }

    this.chunkTokens.delete(chunkId);
  }

  search(query: string): Map<string, number> {
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0) {
      return new Map();
    }

    const candidateChunks = new Set<string>();
    for (const token of queryTokens) {
      const chunks = this.termToChunks.get(token);
      if (chunks) {
        for (const chunkId of chunks) {
          candidateChunks.add(chunkId);
        }
      }
    }

    const scores = new Map<string, number>();
    const k1 = 1.2;
    const b = 0.75;
    const avgDocLength = 100;

    for (const chunkId of candidateChunks) {
      const termFreq = this.chunkTokens.get(chunkId);
      if (!termFreq) continue;

      const docLength = Array.from(termFreq.values()).reduce((a, b) => a + b, 0);
      let score = 0;

      for (const term of queryTokens) {
        const tf = termFreq.get(term) || 0;
        if (tf === 0) continue;

        const numerator = tf * (k1 + 1);
        const denominator = tf + k1 * (1 - b + b * (docLength / avgDocLength));
        score += numerator / denominator;
      }

      const maxPossibleScore = queryTokens.length * (k1 + 1);
      scores.set(chunkId, maxPossibleScore > 0 ? score / maxPossibleScore : 0);
    }

    return scores;
  }

  hasChunk(chunkId: string): boolean {
    return this.chunkTokens.has(chunkId);
  }

  clear(): void {
    this.termToChunks.clear();
    this.chunkTokens.clear();
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2);
  }
}
