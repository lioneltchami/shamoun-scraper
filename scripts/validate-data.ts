/**
 * validate-data.ts
 *
 * Data integrity check for the Shamoun Apologetics Library database.
 * Run after any ingestion pipeline step to verify counts, completeness,
 * and consistency across articles, chunks, and verse indexes.
 *
 * Usage:
 *   tsx scripts/validate-data.ts
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import type { PostgrestFilterBuilder } from "@supabase/postgrest-js";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";
import { fileURLToPath } from "url";
import { CATEGORIES } from "../src/lib/categories";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error(
    "ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.",
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXPECTED_CATEGORY_COUNT = CATEGORIES.length;
const EXPECTED_MIN_ARTICLE_COUNT = CATEGORIES.reduce(
  (sum: number, category) => sum + category.articleCount,
  0,
);
const EMBEDDING_DIMENSIONS = 1536;

let passCount = 0;
let failCount = 0;
let warnCount = 0;

function header(title: string): void {
  const bar = "=".repeat(60);
  console.log(`\n${bar}`);
  console.log(`  ${title}`);
  console.log(bar);
}

function pass(label: string, detail = ""): void {
  passCount++;
  const suffix = detail ? `  (${detail})` : "";
  console.log(`  [PASS]  ${label}${suffix}`);
}

function fail(label: string, detail = ""): void {
  failCount++;
  const suffix = detail ? `  --> ${detail}` : "";
  console.log(`  [FAIL]  ${label}${suffix}`);
}

function warn(label: string, detail = ""): void {
  warnCount++;
  const suffix = detail ? `  --> ${detail}` : "";
  console.log(`  [WARN]  ${label}${suffix}`);
}

function info(label: string, value: string | number): void {
  console.log(`  [INFO]  ${label}: ${value}`);
}

// Supabase returns count via { count } when { count: "exact" } is passed.
// The filter callback receives a PostgrestFilterBuilder (i.e. after .select()
// has already been called) so callers can chain .eq(), .or(), .lt(), etc.
type AnyFilterBuilder = PostgrestFilterBuilder<any, any, any, any, any>;

async function countRows(
  table: string,
  filter?: (q: AnyFilterBuilder) => AnyFilterBuilder,
): Promise<number> {
  // Cast through unknown so TypeScript accepts AnyFilterBuilder in both directions.
  const base = supabase
    .from(table)
    .select("*", { count: "exact", head: true }) as unknown as AnyFilterBuilder;
  const query: AnyFilterBuilder = filter ? filter(base) : base;
  const { count, error } = await (query as unknown as Promise<{
    count: number | null;
    error: { message: string } | null;
  }>);
  if (error)
    throw new Error(`Count query failed on ${table}: ${error.message}`);
  return count ?? 0;
}

async function fetchRows<T>(
  table: string,
  columns: string,
  filter?: (q: AnyFilterBuilder) => AnyFilterBuilder,
): Promise<T[]> {
  const rows: T[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const base = supabase
      .from(table)
      .select(columns)
      .range(from, from + pageSize - 1) as unknown as AnyFilterBuilder;
    const query: AnyFilterBuilder = filter ? filter(base) : base;
    const { data, error } = await (query as unknown as Promise<{
      data: T[] | null;
      error: { message: string } | null;
    }>);

    if (error) {
      throw new Error(`Fetch query failed on ${table}: ${error.message}`);
    }

    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) return rows;
  }
}

// ---------------------------------------------------------------------------
// Section 1 - Article Validation
// ---------------------------------------------------------------------------

async function validateArticles(): Promise<void> {
  header("SECTION 1 - ARTICLE VALIDATION");

  // 1a. Total count
  const total = await countRows("articles");
  info("Total articles in database", total);
  if (total < EXPECTED_MIN_ARTICLE_COUNT) {
    fail(
      `Article count below expected minimum`,
      `expected at least ${EXPECTED_MIN_ARTICLE_COUNT}, got ${total}`,
    );
  } else if (total > EXPECTED_MIN_ARTICLE_COUNT) {
    warn(
      `Article count exceeds expected minimum`,
      `found ${total - EXPECTED_MIN_ARTICLE_COUNT} extra article rows`,
    );
  } else {
    pass(
      `Article count matches expected minimum ${EXPECTED_MIN_ARTICLE_COUNT}`,
      `${total} found`,
    );
  }

  // 1b. Empty content. Stub rows can be source-only placeholders, but a
  //     non-stub article with no body is a broken content row.
  const emptyNonStubContent = await countRows("articles", (q) =>
    q.eq("is_stub", false).or("content.is.null,content.eq."),
  );
  const emptyStubContent = await countRows("articles", (q) =>
    q.eq("is_stub", true).or("content.is.null,content.eq."),
  );
  if (emptyNonStubContent === 0) {
    pass("No non-stub articles with empty content");
  } else {
    fail(`Non-stub articles with empty content`, `${emptyNonStubContent} found`);
  }
  if (emptyStubContent > 0) {
    warn(
      "Stub articles with empty content",
      `${emptyStubContent} source-only placeholder rows`,
    );
  }

  // 1c. Missing titles
  const missingTitles = await countRows("articles", (q) =>
    q.or("title.is.null,title.eq."),
  );
  if (missingTitles === 0) {
    pass("No articles with missing titles");
  } else {
    fail(`Articles with missing titles`, `${missingTitles} found`);
  }

  // 1d. Duplicate slugs - slugs are UNIQUE in schema so any count > 0 is a
  //     schema violation; we verify by checking distinct slug count matches total.
  try {
    const slugData = await fetchRows<{ slug: string }>("articles", "slug");
    const allSlugs = slugData.map((r) => r.slug);
    const uniqueSlugs = new Set(allSlugs).size;
    if (uniqueSlugs === allSlugs.length) {
      pass("No duplicate slugs", `${uniqueSlugs} unique slugs`);
    } else {
      fail(
        "Duplicate slugs detected",
        `${allSlugs.length - uniqueSlugs} duplicates`,
      );
    }
  } catch (error) {
    fail(
      "Duplicate slug check failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  // 1e. Category distribution
  console.log("\n  Category distribution:");
  try {
    type ArticleRow = { category_id: number; category_name: string };
    const rows = await fetchRows<ArticleRow>(
      "articles",
      "category_id, category_name",
    );
    const catMap = new Map<number, { name: string; count: number }>();
    for (const row of rows) {
      const existing = catMap.get(row.category_id);
      if (existing) {
        existing.count++;
      } else {
        catMap.set(row.category_id, { name: row.category_name, count: 1 });
      }
    }
    const sortedCats = [...catMap.entries()].sort(([a], [b]) => a - b);
    for (const [catId, { name, count }] of sortedCats) {
      console.log(
        `    [${String(catId).padStart(2, "0")}] ${name.padEnd(45)} ${count}`,
      );
    }
    info("Distinct categories found", sortedCats.length);
    if (sortedCats.length === EXPECTED_CATEGORY_COUNT) {
      pass(`All ${EXPECTED_CATEGORY_COUNT} categories represented`);
    } else {
      fail(
        `Category count mismatch`,
        `expected ${EXPECTED_CATEGORY_COUNT}, got ${sortedCats.length}`,
      );
    }
  } catch (error) {
    fail(
      "Category distribution query failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  // 1f. Stub articles
  const stubCount = await countRows("articles", (q) => q.eq("is_stub", true));
  info("Stub articles (is_stub = true)", stubCount);
  if (stubCount > 0) {
    warn(
      `Stub articles present`,
      `${stubCount} stubs -- these will be excluded from chunk validation`,
    );
  } else {
    pass("No stub articles");
  }
}

// ---------------------------------------------------------------------------
// Section 2 - Chunk Validation
// ---------------------------------------------------------------------------

async function validateChunks(): Promise<void> {
  header("SECTION 2 - CHUNK VALIDATION");

  const chunkTotal = await countRows("article_chunks");
  info("Total chunks in database", chunkTotal);

  if (chunkTotal === 0) {
    warn("No chunks found -- skipping chunk validation (run db:embed first)");
    return;
  }

  pass("Chunk table is populated", `${chunkTotal} rows`);

  // 2a. Articles with no chunks (excluding stubs) -- client-side set difference
  try {
    type ArticleMinimal = { id: string; title: string; is_stub: boolean };
    const nonStubs = await fetchRows<ArticleMinimal>(
      "articles",
      "id, title, is_stub",
      (q) => q.eq("is_stub", false),
    );
    const chunkedIds = await fetchRows<{ article_id: string }>(
      "article_chunks",
      "article_id",
    );
      const chunked = new Set(
      chunkedIds.map((r) => r.article_id),
      );
      const missing = nonStubs.filter((a) => !chunked.has(a.id));
      if (missing.length === 0) {
        pass("All non-stub articles have at least one chunk");
      } else {
        fail(`Non-stub articles missing chunks`, `${missing.length} articles`);
        for (const a of missing.slice(0, 10)) {
          console.log(`    - ${a.title} (${a.id})`);
        }
        if (missing.length > 10) {
          console.log(`    ... and ${missing.length - 10} more`);
        }
      }
  } catch (error) {
    fail(
      "Could not check articles for missing chunks",
      error instanceof Error ? error.message : String(error),
    );
  }

  // 2b. Chunks with null embeddings
  const nullEmbeddings = await countRows("article_chunks", (q) =>
    q.is("embedding", null),
  );
  if (nullEmbeddings === 0) {
    pass("No chunks with null embeddings");
  } else {
    warn(
      `Chunks with null embeddings`,
      `${nullEmbeddings} -- embeddings not yet generated for these`,
    );
  }

  // 2c. Embedding dimensions -- sample 5 chunks and verify vector length
  const { data: sampleChunks, error: sampleError } = await supabase
    .from("article_chunks")
    .select("id, embedding")
    .not("embedding", "is", null)
    .limit(5);

  if (sampleError) {
    warn(
      "Could not sample embeddings for dimension check",
      sampleError.message,
    );
  } else if (!sampleChunks || sampleChunks.length === 0) {
    warn("No non-null embeddings available to dimension-check");
  } else {
    type ChunkRow = { id: string; embedding: number[] | string };
    let allCorrect = true;
    for (const chunk of sampleChunks as ChunkRow[]) {
      // Supabase returns vectors as a bracketed string "[0.1,0.2,...]"
      const raw = chunk.embedding;
      let dims: number;
      if (typeof raw === "string") {
        dims = raw.split(",").length;
      } else if (Array.isArray(raw)) {
        dims = raw.length;
      } else {
        dims = -1;
      }
      if (dims !== EMBEDDING_DIMENSIONS) {
        fail(
          `Embedding dimension mismatch on chunk ${chunk.id}`,
          `expected ${EMBEDDING_DIMENSIONS}, got ${dims}`,
        );
        allCorrect = false;
      }
    }
    if (allCorrect) {
      pass(
        `Embedding dimensions verified (${EMBEDDING_DIMENSIONS})`,
        `sampled ${sampleChunks.length} chunks`,
      );
    }
  }

  // 2d. Average chunks per article
  const nonStubCount = await countRows("articles", (q) =>
    q.eq("is_stub", false),
  );
  if (nonStubCount > 0) {
    const avg = (chunkTotal / nonStubCount).toFixed(1);
    info("Average chunks per non-stub article", avg);
    const avgNum = parseFloat(avg);
    if (avgNum >= 2 && avgNum <= 30) {
      pass("Average chunks per article is within expected range (2-30)");
    } else {
      warn(
        "Average chunks per article is outside expected range",
        `got ${avg}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Section 3 - Verse Validation
// ---------------------------------------------------------------------------

async function validateVerses(): Promise<void> {
  header("SECTION 3 - VERSE VALIDATION");

  const bibleCount = await countRows("bible_verses");
  const quranCount = await countRows("quran_verses");

  info("Unique Bible verses indexed", bibleCount);
  info("Unique Quran verses indexed", quranCount);

  if (bibleCount === 0 && quranCount === 0) {
    warn(
      "No verse data found -- skipping verse validation (run db:verses first)",
    );
    return;
  }

  // 3a. Bible verses with no article associations -- client-side set difference
  if (bibleCount > 0) {
    try {
      const allBibleVerses = await fetchRows<{ id: string }>("bible_verses", "id");
      const linkedBibleVerses = await fetchRows<{ verse_id: string }>(
        "article_bible_verses",
        "verse_id",
      );
      const linkedBibleIds = new Set(linkedBibleVerses.map((r) => r.verse_id));
      const orphans = allBibleVerses.filter((r) => !linkedBibleIds.has(r.id)).length;
      if (orphans === 0) {
        pass("All Bible verses have at least one article association");
      } else {
        warn("Orphaned Bible verses (no linked articles)", `${orphans} verses`);
      }
    } catch (error) {
      warn(
        "Could not check orphaned Bible verses",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // 3b. Quran verses with no article associations -- client-side set difference
  if (quranCount > 0) {
    try {
      const allQuranVerses = await fetchRows<{ id: string }>("quran_verses", "id");
      const linkedQuranVerses = await fetchRows<{ verse_id: string }>(
        "article_quran_verses",
        "verse_id",
      );
      const linkedQuranIds = new Set(linkedQuranVerses.map((r) => r.verse_id));
      const orphans = allQuranVerses.filter((r) => !linkedQuranIds.has(r.id)).length;
      if (orphans === 0) {
        pass("All Quran verses have at least one article association");
      } else {
        warn("Orphaned Quran verses (no linked articles)", `${orphans} verses`);
      }
    } catch (error) {
      warn(
        "Could not check orphaned Quran verses",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // 3c. Top 10 most-cited Bible verses
  if (bibleCount > 0) {
    console.log("\n  Top 10 most-cited Bible verses:");
    // Fetch all junction rows and aggregate by verse
    try {
      const junctionRows = await fetchRows<{ verse_id: string; occurrence_count: number }>(
        "article_bible_verses",
        "verse_id, occurrence_count",
      );
      const verseTotals = new Map<string, number>();
      for (const row of junctionRows) {
        verseTotals.set(row.verse_id, (verseTotals.get(row.verse_id) ?? 0) + (row.occurrence_count ?? 1));
      }
      const topBibleIds = [...verseTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

      // Fetch references for the top 10 verses
      const { data: verseRefs } = await supabase
        .from("bible_verses")
        .select("id, reference")
        .in("id", topBibleIds.map(([id]) => id));
      const refMap = new Map((verseRefs ?? []).map((r: { id: string; reference: string }) => [r.id, r.reference]));

      for (let i = 0; i < topBibleIds.length; i++) {
        const [verseId, total] = topBibleIds[i];
        const reference = refMap.get(verseId) ?? verseId;
        console.log(
          `    ${String(i + 1).padStart(2)}. ${reference.padEnd(30)} ${total} citations`,
        );
      }
    } catch (error) {
      warn(
        "Could not fetch top Bible verses",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // 3d. Top 10 most-cited Quran verses
  if (quranCount > 0) {
    console.log("\n  Top 10 most-cited Quran verses:");
    // Fetch all junction rows and aggregate by verse
    try {
      const junctionRows = await fetchRows<{ verse_id: string; occurrence_count: number }>(
        "article_quran_verses",
        "verse_id, occurrence_count",
      );
      const verseTotals = new Map<string, number>();
      for (const row of junctionRows) {
        verseTotals.set(row.verse_id, (verseTotals.get(row.verse_id) ?? 0) + (row.occurrence_count ?? 1));
      }
      const topQuranIds = [...verseTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

      // Fetch references for the top 10 verses
      const { data: verseRefs } = await supabase
        .from("quran_verses")
        .select("id, reference, surah_name")
        .in("id", topQuranIds.map(([id]) => id));
      const refMap = new Map((verseRefs ?? []).map((r: { id: string; reference: string; surah_name: string | null }) => [r.id, { reference: r.reference, surahName: r.surah_name ?? "" }]));

      for (let i = 0; i < topQuranIds.length; i++) {
        const [verseId, total] = topQuranIds[i];
        const info = refMap.get(verseId);
        const label = info ? (info.surahName ? `${info.reference} (${info.surahName})` : info.reference) : verseId;
        console.log(
          `    ${String(i + 1).padStart(2)}. ${label.padEnd(35)} ${total} citations`,
        );
      }
    } catch (error) {
      warn(
        "Could not fetch top Quran verses",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // 3e. Sanity checks on verse data
  if (quranCount > 0) {
    // Surah must be 1-114
    const invalidSurah = await countRows("quran_verses", (q) =>
      q.or("surah.lt.1,surah.gt.114"),
    );
    if (invalidSurah === 0) {
      pass("All Quran surah numbers are within valid range (1-114)");
    } else {
      fail(`Quran verses with invalid surah number`, `${invalidSurah} found`);
    }

    // ayah_start must be >= 1
    const invalidAyah = await countRows("quran_verses", (q) =>
      q.lt("ayah_start", 1),
    );
    if (invalidAyah === 0) {
      pass("All Quran ayah_start values are >= 1");
    } else {
      fail(`Quran verses with ayah_start < 1`, `${invalidAyah} found`);
    }
  }

  if (bibleCount > 0) {
    // Chapter must be >= 1
    const invalidChapter = await countRows("bible_verses", (q) =>
      q.lt("chapter", 1),
    );
    if (invalidChapter === 0) {
      pass("All Bible chapter numbers are >= 1");
    } else {
      fail(`Bible verses with chapter < 1`, `${invalidChapter} found`);
    }

    // verse_start must be >= 1
    const invalidVerseStart = await countRows("bible_verses", (q) =>
      q.lt("verse_start", 1),
    );
    if (invalidVerseStart === 0) {
      pass("All Bible verse_start values are >= 1");
    } else {
      fail(`Bible verses with verse_start < 1`, `${invalidVerseStart} found`);
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary(): void {
  header("VALIDATION SUMMARY");
  console.log(`  Passed : ${passCount}`);
  console.log(`  Failed : ${failCount}`);
  console.log(`  Warned : ${warnCount}`);
  console.log();
  if (failCount === 0) {
    console.log("  RESULT: ALL CHECKS PASSED");
  } else {
    console.log(
      `  RESULT: ${failCount} CHECK(S) FAILED -- review output above`,
    );
  }
  console.log("=".repeat(60));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Shamoun Apologetics Library - Data Validation");
  console.log(`Run at: ${new Date().toISOString()}`);

  try {
    await validateArticles();
    await validateChunks();
    await validateVerses();
    printSummary();
  } catch (err) {
    console.error("\nFATAL: Unhandled error during validation:");
    console.error(err);
    process.exit(1);
  }

  if (failCount > 0) {
    process.exit(1);
  }
}

main();
