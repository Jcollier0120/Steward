import { esc } from './page.ts';

/**
 * Lexical search over an agent's own records, in memory: BM25 over the fields the agent names (each with its weight),
 * with a highlighted snippet from the best passage. Code only; tens of thousands of records answer in milliseconds.
 * Kit 2.87.0: the Clerk's search (over its rolls) and the Chamberlain's (over documents and mail) were one file copied
 * twice; each now says what its records are made of here.
 *
 * - The Clerk: fields the OCR text (1), the caption (1) and the file name without its extension (NAME_WEIGHT);
 *   passages the text, then the caption; newest by mtimeMs.
 * - The Chamberlain: fields the text (1), sender and recipients (1) and the title (NAME_WEIGHT); passages the text;
 *   newest by `at`; its kind (documents, mail or both) is the search's filter.
 */

/** Words of two characters or more, lower case. A word mixing letters and digits ("0x25006", "err42")
 *  also yields its parts, so "25006" finds "0x25006". */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().normalize('NFKC').matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    if (w.length >= 2) out.push(w);
    if (/\p{L}/u.test(w) && /\p{N}/u.test(w)) for (const part of w.match(/\p{L}+|\p{N}+/gu) ?? []) if (part.length >= 2 && part !== w) out.push(part);
  }
  return out;
}

export const K1 = 1.2;
export const B = 0.75;
/** The weight both agents give a record's name (a file name, a message's subject): it counts double. */
export const NAME_WEIGHT = 2;
/** A query word of 4+ letters also finds words that start with it ("print" finds "printer"), at this weight. */
export const PREFIX_WEIGHT = 0.6;
export const MAX_EXPANSIONS = 30;

/** A field of a record that is searched: its text (nothing when it has none), and how much each word in it counts (1). */
export interface Field<D> {
  text: (doc: D) => string | null | undefined;
  weight?: number;
}

/** A field a hit's snippet may come from, and what the hit's `from` says when it does. */
export interface Passage<D, F extends string = string> {
  from: F;
  text: (doc: D) => string | null | undefined;
}

export interface IndexOptions<D, F extends string = string> {
  /** What is searched, in this order (the order words are first seen in, which the prefix matches follow). */
  fields: Field<D>[];
  /**
   * Where the snippet comes from: the first passage, or a later one when an earlier one has none of the query's words
   * and the later one has some (or the earlier one is empty). The first field, from 'text', when not given.
   */
  passages?: Passage<D, F>[];
  /** Equal scores: the record with the larger number first (its time). Else in the records' order. */
  newest?: (doc: D) => number;
}

export interface Hit<D, F extends string = string> {
  doc: D;
  score: number;
  /** HTML: the best passage, escaped, with the query's words in <mark>. */
  snippet: string;
  /** The same passage as plain text (for re-ranking by meaning, and for asking about it). */
  passage: string;
  /** Which passage it is (the Clerk's 'text' or 'caption'). */
  from: F;
}

export class SearchIndex<D, F extends string = string> {
  readonly docs: D[];
  private readonly o: IndexOptions<D, F>;
  private readonly passages: Passage<D, F>[];
  private postings = new Map<string, { doc: number[]; tf: number[] }>();
  private lengths: Float64Array;
  private avgLength: number;
  private vocab: string[] = [];

  constructor(docs: D[], o: IndexOptions<D, F>) {
    this.docs = docs;
    this.o = o;
    this.passages = o.passages ?? [{ from: 'text' as F, text: o.fields[0].text }];
    this.lengths = new Float64Array(docs.length);
    let total = 0;
    docs.forEach((r, d) => {
      const counts = new Map<string, number>();
      const add = (t: string, w: number) => counts.set(t, (counts.get(t) ?? 0) + w);
      let len = 0;
      for (const f of o.fields) {
        const text = f.text(r);
        if (text) for (const t of tokenize(text)) add(t, f.weight ?? 1), len++;
      }
      this.lengths[d] = len;
      total += len;
      for (const [t, tf] of counts) {
        let p = this.postings.get(t);
        if (!p) this.postings.set(t, (p = { doc: [], tf: [] }));
        p.doc.push(d);
        p.tf.push(tf);
      }
    });
    this.avgLength = docs.length ? total / docs.length : 1;
    this.vocab = [...this.postings.keys()];
  }

  /** The query's words, each with the indexed words it matches (itself, and prefixes of 4+ letters). */
  private expand(query: string): { term: string; matches: [string, number][] }[] {
    const terms = [...new Set(tokenize(query))];
    return terms.map((term) => {
      const matches: [string, number][] = this.postings.has(term) ? [[term, 1]] : [];
      if (term.length >= 4) {
        for (const v of this.vocab) {
          if (matches.length > MAX_EXPANSIONS) break;
          if (v !== term && v.startsWith(term)) matches.push([v, PREFIX_WEIGHT]);
        }
      }
      return { term, matches };
    });
  }

  /**
   * The best `limit` records for the query's words. `filter` leaves records out of the answer (the Chamberlain's kind),
   * not out of how rare a word is; `width` is the passage's length (220 characters).
   */
  search(query: string, limit = 50, o: { filter?: (doc: D) => boolean; width?: number } = {}): Hit<D, F>[] {
    const n = this.docs.length;
    if (!n) return [];
    const expanded = this.expand(query);
    const scores = new Map<number, number>();
    for (const { matches } of expanded) {
      // Per query word, the best of its matches counts, so "print" doesn't score once per "print*" word.
      const best = new Map<number, number>();
      for (const [t, weight] of matches) {
        const p = this.postings.get(t)!;
        const idf = Math.log(1 + (n - p.doc.length + 0.5) / (p.doc.length + 0.5));
        for (let i = 0; i < p.doc.length; i++) {
          const d = p.doc[i];
          if (o.filter && !o.filter(this.docs[d])) continue;
          const tf = p.tf[i];
          const s = weight * idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * this.lengths[d]) / this.avgLength)));
          if (s > (best.get(d) ?? 0)) best.set(d, s);
        }
      }
      for (const [d, s] of best) scores.set(d, (scores.get(d) ?? 0) + s);
    }
    const words = expanded.flatMap((e) => e.matches.map(([t]) => t));
    const newest = this.o.newest;
    return [...scores]
      .sort((a, b) => b[1] - a[1] || (newest ? newest(this.docs[b[0]]) - newest(this.docs[a[0]]) : 0))
      .slice(0, limit)
      .map(([d, score]) => {
        const r = this.docs[d];
        const [first, ...rest] = this.passages;
        // The first passage, or a later one's when only the later one has the words.
        let s = snippet(first.text(r) ?? '', words, o.width);
        let from = first.from;
        for (const p of rest) {
          if (s.html.includes('<mark>')) break;
          const text = p.text(r);
          if (!text) continue;
          const c = snippet(text, words, o.width);
          if (c.html.includes('<mark>') || !s.html) {
            s = c;
            from = p.from;
          }
        }
        return { doc: r, score, snippet: s.html, passage: s.text, from };
      });
  }
}

/**
 * The passage of about `width` characters with the most distinct query words (then the most matches),
 * escaped, with matching words in <mark>. Line breaks show as " · ".
 */
export function snippet(text: string, words: string[], width = 220): { html: string; text: string } {
  const flat = text.replace(/\s*\n\s*/g, ' · ').replace(/\s+/g, ' ').trim();
  if (!flat) return { html: '', text: '' };
  const want = new Set(words.map((w) => w.toLowerCase()));
  const hits: { start: number; end: number; word: string }[] = [];
  for (const m of flat.matchAll(/[\p{L}\p{N}]+/gu)) {
    const toks = tokenize(m[0]);
    const word = toks.find((t) => want.has(t));
    if (word) hits.push({ start: m.index!, end: m.index! + m[0].length, word });
  }
  let from = 0;
  if (hits.length) {
    let best = { distinct: -1, count: -1, start: 0 };
    for (let i = 0; i < hits.length; i++) {
      const seen = new Set<string>();
      let count = 0;
      for (let j = i; j < hits.length && hits[j].end - hits[i].start <= width; j++) {
        seen.add(hits[j].word);
        count++;
      }
      if (seen.size > best.distinct || (seen.size === best.distinct && count > best.count)) best = { distinct: seen.size, count, start: hits[i].start };
    }
    // Some context before the first match, starting at a word boundary.
    from = Math.max(0, best.start - Math.floor(width / 4));
    if (from > 0) {
      const sp = flat.indexOf(' ', from);
      from = sp >= 0 && sp < best.start ? sp + 1 : best.start;
    }
  }
  let to = Math.min(flat.length, from + width);
  if (to < flat.length) {
    const sp = flat.lastIndexOf(' ', to);
    if (sp > from + width / 2) to = sp;
  }
  let html = from > 0 ? '… ' : '';
  let at = from;
  for (const h of hits) {
    if (h.start < from || h.end > to) continue;
    html += esc(flat.slice(at, h.start)) + '<mark>' + esc(flat.slice(h.start, h.end)) + '</mark>';
    at = h.end;
  }
  html += esc(flat.slice(at, to)) + (to < flat.length ? ' …' : '');
  return { html, text: flat.slice(from, to) };
}
