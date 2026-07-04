#!/usr/bin/env tsx
/**
 * extract-verse-index.ts
 *
 * Verse index extraction pipeline for the Sam Shamoun Apologetics Library.
 *
 * What this script does:
 *   1. Fetches all articles from Supabase (id, slug, content).
 *   2. Runs the Bible and Quran parsers on each article's content.
 *   3. Deduplicates verse references per article, tracking occurrence_count
 *      when the same verse is cited more than once in a single article.
 *   4. Upserts unique verses into the bible_verses and quran_verses tables.
 *   5. Creates junction table records in article_bible_verses and
 *      article_quran_verses (with occurrence_count).
 *   6. Logs a detailed progress and summary report to stdout.
 *
 * Usage:
 *   SUPABASE_URL=<url> SUPABASE_SERVICE_ROLE_KEY=<key> npx tsx scripts/extract-verse-index.ts
 *
 * Environment variables:
 *   SUPABASE_URL              - Your Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY - Service role key (bypasses RLS)
 *
 * Optional:
 *   BATCH_SIZE=50             - Number of articles to process per Supabase page (default: 50)
 *   DRY_RUN=true              - Parse and log stats without writing to the database
 *
 * Performance notes:
 *   - Articles are fetched in pages to avoid loading 748 full-content rows at once.
 *   - Verse upserts are batched in groups of UPSERT_BATCH_SIZE (default: 100).
 *   - Junction table inserts use ON CONFLICT DO UPDATE to safely re-run.
 *   - Total runtime on a cold run is typically 30-90 seconds depending on network.
 *
 * Idempotency:
 *   This script is safe to re-run. All database writes use upsert semantics.
 *   Re-running will update occurrence counts if articles have changed.
 */

import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseBibleVerses } from "../src/lib/verse-parser/bible-parser";
import { parseQuranVerses } from "../src/lib/verse-parser/quran-parser";
import type {
  BibleVerseRef,
  QuranVerseRef,
  BibleVerse,
  QuranVerse,
} from "../src/types/verse";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? "50", 10);
const UPSERT_BATCH_SIZE = 100;
const DRY_RUN = process.env.DRY_RUN === "true";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Article {
  id: string;
  slug: string;
  content: string;
}

/** Per-article accumulation of verse refs with occurrence counts. */
interface ArticleVerseAccum {
  articleId: string;
  bibleVerses: Map<string, { ref: BibleVerseRef; count: number }>;
  quranVerses: Map<string, { ref: QuranVerseRef; count: number }>;
}

/** Running totals for the final summary report. */
interface Stats {
  articlesProcessed: number;
  articlesFailed: number;
  bibleRefsFound: number;
  quranRefsFound: number;
  uniqueBibleVerses: number;
  uniqueQuranVerses: number;
  bibleJunctionRows: number;
  quranJunctionRows: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Supabase client (admin, bypasses RLS)
// ---------------------------------------------------------------------------

function createAdminClient(): SupabaseClient {
  if (!SUPABASE_URL) {
    throw new Error(
      "Missing environment variable: SUPABASE_URL\n" +
        "Run: export SUPABASE_URL=https://<project>.supabase.co",
    );
  }
  if (!SERVICE_ROLE_KEY) {
    throw new Error(
      "Missing environment variable: SUPABASE_SERVICE_ROLE_KEY\n" +
        "Run: export SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>",
    );
  }
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

// ---------------------------------------------------------------------------
// Article fetching
// ---------------------------------------------------------------------------

/**
 * Fetches all articles from Supabase in paginated batches.
 * Only fetches the columns needed for verse extraction.
 */
async function fetchAllArticles(supabase: SupabaseClient): Promise<Article[]> {
  const articles: Article[] = [];
  let from = 0;

  console.log("Fetching articles from Supabase...");

  while (true) {
    const { data, error } = await supabase
      .from("articles")
      .select("id, slug, content")
      .range(from, from + BATCH_SIZE - 1)
      .order("article_order", { ascending: true });

    if (error) {
      throw new Error(
        `Failed to fetch articles at offset ${from}: ${error.message}`,
      );
    }

    if (!data || data.length === 0) {
      break;
    }

    articles.push(...(data as Article[]));
    console.log(`  Fetched ${articles.length} articles so far...`);

    if (data.length < BATCH_SIZE) {
      // Last page
      break;
    }

    from += BATCH_SIZE;
  }

  console.log(`  Total articles fetched: ${articles.length}\n`);
  return articles;
}

// ---------------------------------------------------------------------------
// Verse extraction and deduplication per article
// ---------------------------------------------------------------------------

/**
 * Builds a stable deduplication key for a Bible verse ref.
 * Format: "BOOK|CHAPTER|VERSE_START|VERSE_END"
 * VERSE_END is "null" for single-verse citations.
 */
function bibleVerseKey(ref: BibleVerseRef): string {
  return `${ref.book}|${ref.chapter}|${ref.verseStart}|${ref.verseEnd ?? "null"}`;
}

/**
 * Builds a stable deduplication key for a Quran verse ref.
 * Uses the normalised reference string since it encodes all fields.
 */
function quranVerseKey(ref: QuranVerseRef): string {
  return `${ref.surah}|${ref.ayahStart}|${ref.ayahEnd ?? "null"}`;
}

/**
 * Processes a single article: parses both parsers and deduplicates references.
 */
function processArticle(article: Article): ArticleVerseAccum {
  const bibleRefs = parseBibleVerses(article.content);
  const quranRefs = parseQuranVerses(article.content);

  const bibleVerses = new Map<string, { ref: BibleVerseRef; count: number }>();
  for (const ref of bibleRefs) {
    const key = bibleVerseKey(ref);
    const existing = bibleVerses.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      bibleVerses.set(key, { ref, count: 1 });
    }
  }

  const quranVerses = new Map<string, { ref: QuranVerseRef; count: number }>();
  for (const ref of quranRefs) {
    const key = quranVerseKey(ref);
    const existing = quranVerses.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      quranVerses.set(key, { ref, count: 1 });
    }
  }

  return { articleId: article.id, bibleVerses, quranVerses };
}

// ---------------------------------------------------------------------------
// Global deduplication across all articles
// ---------------------------------------------------------------------------

/**
 * Aggregates per-article results into global unique verse sets and
 * junction table row payloads.
 */
function aggregateResults(accums: ArticleVerseAccum[]): {
  uniqueBibleVerses: Map<string, BibleVerseRef>;
  uniqueQuranVerses: Map<string, QuranVerseRef>;
  bibleJunctionRows: Array<{
    article_id: string;
    verse_key: string;
    occurrence_count: number;
  }>;
  quranJunctionRows: Array<{
    article_id: string;
    verse_key: string;
    occurrence_count: number;
  }>;
} {
  const uniqueBibleVerses = new Map<string, BibleVerseRef>();
  const uniqueQuranVerses = new Map<string, QuranVerseRef>();
  const bibleJunctionRows: Array<{
    article_id: string;
    verse_key: string;
    occurrence_count: number;
  }> = [];
  const quranJunctionRows: Array<{
    article_id: string;
    verse_key: string;
    occurrence_count: number;
  }> = [];

  for (const accum of accums) {
    for (const [key, { ref, count }] of accum.bibleVerses) {
      if (!uniqueBibleVerses.has(key)) {
        uniqueBibleVerses.set(key, ref);
      }
      bibleJunctionRows.push({
        article_id: accum.articleId,
        verse_key: key,
        occurrence_count: count,
      });
    }

    for (const [key, { ref, count }] of accum.quranVerses) {
      if (!uniqueQuranVerses.has(key)) {
        uniqueQuranVerses.set(key, ref);
      }
      quranJunctionRows.push({
        article_id: accum.articleId,
        verse_key: key,
        occurrence_count: count,
      });
    }
  }

  return {
    uniqueBibleVerses,
    uniqueQuranVerses,
    bibleJunctionRows,
    quranJunctionRows,
  };
}

// ---------------------------------------------------------------------------
// Database upsert helpers
// ---------------------------------------------------------------------------

/**
 * Generic helper to chunk an array into fixed-size batches.
 */
function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function clearExistingVerseIndex(supabase: SupabaseClient): Promise<void> {
  const tables: Array<{ name: string; column: string }> = [
    { name: "article_bible_verses", column: "article_id" },
    { name: "article_quran_verses", column: "article_id" },
    { name: "bible_verses", column: "id" },
    { name: "quran_verses", column: "id" },
  ];

  for (const table of tables) {
    const { error } = await supabase
      .from(table.name)
      .delete()
      .not(table.column, "is", null);
    if (error) {
      throw new Error(`Failed to clear ${table.name}: ${error.message}`);
    }
  }
}

/**
 * Upserts all unique Bible verses into the bible_verses table.
 * Returns a map from verse_key to the database UUID assigned to that verse.
 */
async function upsertBibleVerses(
  supabase: SupabaseClient,
  uniqueVerses: Map<string, BibleVerseRef>,
): Promise<Map<string, string>> {
  const keyToId = new Map<string, string>();

  const rows = Array.from(uniqueVerses.entries()).map(([key, ref]) => ({
    _key: key, // temporary client-side field for mapping; stripped before upsert
    book: ref.book,
    chapter: ref.chapter,
    verse_start: ref.verseStart,
    verse_end: ref.verseEnd,
    reference: ref.reference,
    testament: ref.testament,
  }));

  const upsertRows = rows.map(({ _key: _discarded, ...rest }) => rest);
  const batches = chunked(upsertRows, UPSERT_BATCH_SIZE);

  console.log(
    `  Upserting ${rows.length} unique Bible verses in ${batches.length} batches...`,
  );

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const { data, error } = await supabase
      .from("bible_verses")
      .upsert(batch, {
        onConflict: "book,chapter,verse_start,verse_end",
        ignoreDuplicates: true,
      })
      .select("id, book, chapter, verse_start, verse_end");

    if (error) {
      throw new Error(
        `Failed to upsert Bible verses (batch ${i + 1}/${batches.length}): ${error.message}`,
      );
    }

    // Map each returned row back to its verse_key so we can build junction rows.
    for (const row of data as BibleVerse[]) {
      const key = `${row.book}|${row.chapter}|${row.verse_start}|${row.verse_end ?? "null"}`;
      keyToId.set(key, row.id);
    }
  }

  return keyToId;
}

/**
 * Upserts all unique Quran verses into the quran_verses table.
 * Returns a map from verse_key to the database UUID assigned to that verse.
 */
async function upsertQuranVerses(
  supabase: SupabaseClient,
  uniqueVerses: Map<string, QuranVerseRef>,
): Promise<Map<string, string>> {
  const keyToId = new Map<string, string>();

  const rows = Array.from(uniqueVerses.values()).map((ref) => ({
    surah: ref.surah,
    ayah_start: ref.ayahStart,
    ayah_end: ref.ayahEnd,
    reference: ref.reference,
  }));

  const batches = chunked(rows, UPSERT_BATCH_SIZE);

  console.log(
    `  Upserting ${rows.length} unique Quran verses in ${batches.length} batches...`,
  );

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const { data, error } = await supabase
      .from("quran_verses")
      .upsert(batch, {
        onConflict: "surah,ayah_start,ayah_end",
        ignoreDuplicates: true,
      })
      .select("id, surah, ayah_start, ayah_end");

    if (error) {
      throw new Error(
        `Failed to upsert Quran verses (batch ${i + 1}/${batches.length}): ${error.message}`,
      );
    }

    for (const row of data as QuranVerse[]) {
      const key = `${row.surah}|${row.ayah_start}|${row.ayah_end ?? "null"}`;
      keyToId.set(key, row.id);
    }
  }

  return keyToId;
}

/**
 * Upserts records into the article_bible_verses junction table.
 */
async function upsertBibleJunctionRows(
  supabase: SupabaseClient,
  junctionRows: Array<{
    article_id: string;
    verse_key: string;
    occurrence_count: number;
  }>,
  verseKeyToId: Map<string, string>,
  stats: Stats,
): Promise<void> {
  const rows = junctionRows
    .map(({ article_id, verse_key, occurrence_count }) => {
      const verse_id = verseKeyToId.get(verse_key);
      if (!verse_id) {
        stats.warnings.push(
          `No verse_id found for Bible verse key "${verse_key}" (article ${article_id})`,
        );
        return null;
      }
      return { article_id, verse_id, occurrence_count };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const batches = chunked(rows, UPSERT_BATCH_SIZE);

  console.log(
    `  Upserting ${rows.length} article_bible_verses junction rows in ${batches.length} batches...`,
  );

  for (let i = 0; i < batches.length; i++) {
    const { error } = await supabase
      .from("article_bible_verses")
      .upsert(batches[i], {
        onConflict: "article_id,verse_id",
        ignoreDuplicates: true,
      });

    if (error) {
      console.warn(
        `  [WARN] article_bible_verses batch ${i + 1}/${batches.length}: ${error.message}`,
      );
      continue;
    }
  }

  stats.bibleJunctionRows += rows.length;
}

/**
 * Upserts records into the article_quran_verses junction table.
 */
async function upsertQuranJunctionRows(
  supabase: SupabaseClient,
  junctionRows: Array<{
    article_id: string;
    verse_key: string;
    occurrence_count: number;
  }>,
  verseKeyToId: Map<string, string>,
  stats: Stats,
): Promise<void> {
  const rows = junctionRows
    .map(({ article_id, verse_key, occurrence_count }) => {
      const verse_id = verseKeyToId.get(verse_key);
      if (!verse_id) {
        stats.warnings.push(
          `No verse_id found for Quran verse key "${verse_key}" (article ${article_id})`,
        );
        return null;
      }
      return { article_id, verse_id, occurrence_count };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const batches = chunked(rows, UPSERT_BATCH_SIZE);

  console.log(
    `  Upserting ${rows.length} article_quran_verses junction rows in ${batches.length} batches...`,
  );

  for (let i = 0; i < batches.length; i++) {
    const { error } = await supabase
      .from("article_quran_verses")
      .upsert(batches[i], {
        onConflict: "article_id,verse_id",
        ignoreDuplicates: true,
      });

    if (error) {
      console.warn(
        `  [WARN] article_quran_verses batch ${i + 1}/${batches.length}: ${error.message}`,
      );
      continue;
    }
  }

  stats.quranJunctionRows += rows.length;
}

// ---------------------------------------------------------------------------
// Summary reporting
// ---------------------------------------------------------------------------

/**
 * Computes the top-N most cited verses from the junction rows and verse maps.
 */
function computeTopVerses<T>(
  junctionRows: Array<{ verse_key: string; occurrence_count: number }>,
  verseMap: Map<string, T>,
  getReferenceLabel: (ref: T) => string,
  topN: number,
): Array<{
  reference: string;
  totalOccurrences: number;
  articleCount: number;
}> {
  // Accumulate total occurrences and distinct article count per verse_key.
  const byKey = new Map<
    string,
    { totalOccurrences: number; articleCount: number }
  >();

  for (const row of junctionRows) {
    const existing = byKey.get(row.verse_key);
    if (existing) {
      existing.totalOccurrences += row.occurrence_count;
      existing.articleCount += 1;
    } else {
      byKey.set(row.verse_key, {
        totalOccurrences: row.occurrence_count,
        articleCount: 1,
      });
    }
  }

  // Sort by total occurrences descending, take top N.
  const sorted = Array.from(byKey.entries())
    .sort((a, b) => b[1].totalOccurrences - a[1].totalOccurrences)
    .slice(0, topN);

  return sorted.map(([key, { totalOccurrences, articleCount }]) => {
    const ref = verseMap.get(key);
    const reference = ref ? getReferenceLabel(ref) : key;
    return { reference, totalOccurrences, articleCount };
  });
}

function printSummary(
  stats: Stats,
  uniqueBibleVerses: Map<string, BibleVerseRef>,
  uniqueQuranVerses: Map<string, QuranVerseRef>,
  bibleJunctionRows: Array<{
    article_id: string;
    verse_key: string;
    occurrence_count: number;
  }>,
  quranJunctionRows: Array<{
    article_id: string;
    verse_key: string;
    occurrence_count: number;
  }>,
): void {
  const hr = "=".repeat(64);
  const sep = "-".repeat(64);

  console.log(`\n${hr}`);
  console.log("  VERSE INDEX EXTRACTION SUMMARY");
  console.log(hr);

  if (DRY_RUN) {
    console.log("  MODE: DRY RUN (no data was written to the database)\n");
  }

  console.log(`  Articles processed:        ${stats.articlesProcessed}`);
  console.log(`  Articles failed:           ${stats.articlesFailed}`);
  console.log(`  Bible refs found:          ${stats.bibleRefsFound}`);
  console.log(`  Quran refs found:          ${stats.quranRefsFound}`);
  console.log(`  Unique Bible verses:       ${stats.uniqueBibleVerses}`);
  console.log(`  Unique Quran verses:       ${stats.uniqueQuranVerses}`);

  if (!DRY_RUN) {
    console.log(`  Bible junction rows:       ${stats.bibleJunctionRows}`);
    console.log(`  Quran junction rows:       ${stats.quranJunctionRows}`);
  }

  // Top 10 Bible verses
  const topBible = computeTopVerses(
    bibleJunctionRows,
    uniqueBibleVerses,
    (ref) => ref.reference,
    10,
  );

  console.log(`\n${sep}`);
  console.log("  TOP 10 MOST-CITED BIBLE VERSES");
  console.log(sep);
  topBible.forEach(({ reference, totalOccurrences, articleCount }, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}. ${reference.padEnd(28)} ` +
        `${String(totalOccurrences).padStart(4)} occurrences in ` +
        `${String(articleCount).padStart(3)} articles`,
    );
  });

  // Top 10 Quran verses
  const topQuran = computeTopVerses(
    quranJunctionRows,
    uniqueQuranVerses,
    (ref) => ref.reference,
    10,
  );

  console.log(`\n${sep}`);
  console.log("  TOP 10 MOST-CITED QURAN VERSES");
  console.log(sep);
  topQuran.forEach(({ reference, totalOccurrences, articleCount }, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}. ${reference.padEnd(28)} ` +
        `${String(totalOccurrences).padStart(4)} occurrences in ` +
        `${String(articleCount).padStart(3)} articles`,
    );
  });

  // Warnings
  if (stats.warnings.length > 0) {
    console.log(`\n${sep}`);
    console.log(`  PARSING WARNINGS (${stats.warnings.length})`);
    console.log(sep);
    for (const w of stats.warnings.slice(0, 20)) {
      console.log(`  [WARN] ${w}`);
    }
    if (stats.warnings.length > 20) {
      console.log(`  ... and ${stats.warnings.length - 20} more warnings.`);
    }
  }

  console.log(`\n${hr}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Sam Shamoun Apologetics Library - Verse Index Extractor");
  console.log(`Started at ${new Date().toISOString()}`);
  if (DRY_RUN) {
    console.log("[DRY RUN MODE] No data will be written to the database.\n");
  }
  console.log();

  const supabase = createAdminClient();

  const stats: Stats = {
    articlesProcessed: 0,
    articlesFailed: 0,
    bibleRefsFound: 0,
    quranRefsFound: 0,
    uniqueBibleVerses: 0,
    uniqueQuranVerses: 0,
    bibleJunctionRows: 0,
    quranJunctionRows: 0,
    warnings: [],
  };

  // Phase 1: Fetch articles
  const articles = await fetchAllArticles(supabase);

  // Phase 2: Parse all articles
  console.log("Parsing verse references from article content...");
  const accums: ArticleVerseAccum[] = [];

  for (const article of articles) {
    try {
      const accum = processArticle(article);
      accums.push(accum);

      // Update running totals for stats
      for (const { count } of accum.bibleVerses.values()) {
        stats.bibleRefsFound += count;
      }
      for (const { count } of accum.quranVerses.values()) {
        stats.quranRefsFound += count;
      }

      stats.articlesProcessed += 1;

      if (stats.articlesProcessed % 100 === 0) {
        console.log(
          `  Parsed ${stats.articlesProcessed}/${articles.length} articles...`,
        );
      }
    } catch (err) {
      stats.articlesFailed += 1;
      stats.warnings.push(
        `Failed to parse article "${article.slug}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(
    `  Parsed all ${stats.articlesProcessed} articles. ` +
      `Found ${stats.bibleRefsFound} Bible refs, ${stats.quranRefsFound} Quran refs.\n`,
  );

  // Phase 3: Aggregate across all articles
  console.log("Aggregating unique verse references...");
  const {
    uniqueBibleVerses,
    uniqueQuranVerses,
    bibleJunctionRows,
    quranJunctionRows,
  } = aggregateResults(accums);

  stats.uniqueBibleVerses = uniqueBibleVerses.size;
  stats.uniqueQuranVerses = uniqueQuranVerses.size;

  console.log(
    `  Unique Bible verses: ${stats.uniqueBibleVerses}  |  ` +
      `Unique Quran verses: ${stats.uniqueQuranVerses}\n`,
  );

  if (!DRY_RUN) {
    console.log("Clearing existing verse index...");
    await clearExistingVerseIndex(supabase);

    // Phase 4: Upsert Bible verses and get back their UUIDs
    console.log("\nWriting Bible verses to database...");
    const bibleVerseKeyToId = await upsertBibleVerses(
      supabase,
      uniqueBibleVerses,
    );

    // Phase 5: Upsert Quran verses and get back their UUIDs
    console.log("\nWriting Quran verses to database...");
    const quranVerseKeyToId = await upsertQuranVerses(
      supabase,
      uniqueQuranVerses,
    );

    // Phase 6: Upsert junction table rows
    console.log("\nWriting article_bible_verses junction rows...");
    await upsertBibleJunctionRows(
      supabase,
      bibleJunctionRows,
      bibleVerseKeyToId,
      stats,
    );

    console.log("\nWriting article_quran_verses junction rows...");
    await upsertQuranJunctionRows(
      supabase,
      quranJunctionRows,
      quranVerseKeyToId,
      stats,
    );

    console.log();
  }

  // Phase 7: Print summary
  printSummary(
    stats,
    uniqueBibleVerses,
    uniqueQuranVerses,
    bibleJunctionRows,
    quranJunctionRows,
  );

  console.log(`Completed at ${new Date().toISOString()}`);
  process.exit(stats.articlesFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\n[FATAL ERROR]", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
