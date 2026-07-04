/**
 * Article Ingestion Script
 *
 * Reads markdown articles from articles/, parses metadata,
 * pre-renders markdown to HTML, and upserts into the Supabase `articles` table.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/ingest-articles.ts
 *
 * The script is fully idempotent after the article file_path contract has been
 * reconciled -- re-running it will update existing rows without creating
 * duplicates (upsert on `slug`).
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { fileURLToPath } from "url";
import type { ArticleInsert } from "../src/types/article";

// ─── ESM __dirname shim ───────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Configuration ────────────────────────────────────────────────────────────

const ARTICLES_DIR = path.resolve(__dirname, "../articles");
const SKIP_FILENAMES = new Set(["00_INDEX.md", "00_MASTER_INDEX.md"]);
const STUB_WORD_THRESHOLD = 50;

// Batch size for Supabase upserts -- keeps individual payloads small.
const UPSERT_BATCH_SIZE = 20;

// ─── Environment validation ───────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(
      `\nFATAL: Missing required environment variable: ${name}\n` +
        `Set it before running:\n  ${name}=<value> npx tsx scripts/ingest-articles.ts\n`,
    );
    process.exit(1);
  }
  return val;
}

const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

// ─── Supabase client ──────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
});

// ─── Markdown processor ───────────────────────────────────────────────────────

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeSanitize, defaultSchema)
  .use(rehypeStringify);

async function markdownToHtml(markdown: string): Promise<string> {
  const result = await processor.process(markdown);
  return String(result);
}

// ─── Parsing helpers ──────────────────────────────────────────────────────────

/**
 * Derives the same base slug contract used by src/lib/article-loader.ts.
 */
function filenameToBaseSlug(filename: string, categoryId: number): string {
  const slugRaw = filename
    .replace(/^\d+_/, "")
    .replace(/\.md$/i, "")
    .replace(/[^\w-]/g, "-")
    .replace(/-{2,}/g, "-")
    .toLowerCase();

  return `${categoryId}-${slugRaw}`;
}

/**
 * Extracts the numeric category ID from a folder name like "01_common_questions".
 * Returns 0 if the prefix is missing or malformed.
 */
function parseCategoryId(folderName: string): number {
  const match = folderName.match(/^(\d+)_/);
  if (!match) return 0;
  return parseInt(match[1], 10);
}

/**
 * Extracts the numeric article order from a filename like "001_article_name.md".
 * Returns 0 if the prefix is missing or malformed.
 */
function parseArticleOrder(filename: string): number {
  const match = filename.match(/^(\d+)_/);
  if (!match) return 0;
  return parseInt(match[1], 10);
}

function makeUniqueSlug(baseSlug: string, articleOrder: number, usedSlugs: Set<string>): string {
  const orderSuffix = articleOrder > 0 ? String(articleOrder).padStart(3, "0") : "duplicate";
  let slug = `${baseSlug}-${orderSuffix}`;
  let counter = 2;

  while (usedSlugs.has(slug)) {
    slug = `${baseSlug}-${orderSuffix}-${counter}`;
    counter++;
  }

  return slug;
}

function resolveSlugCollisions(articles: ArticleInsert[]): void {
  const bySlug = new Map<string, ArticleInsert[]>();
  for (const article of articles) {
    bySlug.set(article.slug, [...(bySlug.get(article.slug) ?? []), article]);
  }

  const usedSlugs = new Set<string>();
  for (const [slug, matches] of bySlug.entries()) {
    if (matches.length === 1) {
      usedSlugs.add(slug);
      continue;
    }

    const sorted = [...matches].sort((a, b) => {
      const aOrder = a.article_order ?? 0;
      const bOrder = b.article_order ?? 0;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return (a.file_path ?? a.title).localeCompare(b.file_path ?? b.title);
    });

    for (const article of sorted) {
      article.slug = makeUniqueSlug(slug, article.article_order ?? 0, usedSlugs);
      usedSlugs.add(article.slug);
    }
  }
}

interface ParsedArticle {
  title: string;
  sourceUrl: string | null;
  categoryName: string;
  content: string;
}

/**
 * Parses the structured header block at the top of every article file and
 * splits out the body content (everything after the first `---` separator).
 *
 * Handles missing or malformed headers gracefully -- logs a warning and
 * falls back to reasonable defaults so the ingestion can continue.
 */
function parseArticleFile(rawText: string, filePath: string): ParsedArticle {
  const lines = rawText.split(/\r?\n/);

  // Title: first non-empty line starting with `#`
  let title = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      title = trimmed.replace(/^#+\s*/, "").trim();
      break;
    }
  }

  if (!title) {
    console.warn(`  [WARN] No title found in: ${filePath}`);
    title = path
      .basename(filePath, ".md")
      .replace(/^\d+_/, "")
      .replace(/_/g, " ");
  }

  // Source URL: line matching `**Source:** [url](url)` or `**Source:** url`
  let sourceUrl: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\*\*Source:\*\*/.test(trimmed)) {
      // Markdown link: [text](url)
      const mdLinkMatch = trimmed.match(/\(([^)]+)\)/);
      if (mdLinkMatch) {
        sourceUrl = mdLinkMatch[1].trim();
      } else {
        // Plain URL after the label
        const plain = trimmed.replace(/^\*\*Source:\*\*\s*/, "").trim();
        if (plain) sourceUrl = plain;
      }
      break;
    }
  }

  // Category name: line matching `**Category:** XX Name`
  let categoryName = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\*\*Category:\*\*/.test(trimmed)) {
      categoryName = trimmed.replace(/^\*\*Category:\*\*\s*/, "").trim();
      break;
    }
  }

  if (!categoryName) {
    console.warn(`  [WARN] No category found in: ${filePath}`);
  }

  // Content: everything after the first `---` separator line
  const separatorIndex = lines.findIndex((l) => l.trim() === "---");
  let content = "";
  if (separatorIndex !== -1) {
    content = lines
      .slice(separatorIndex + 1)
      .join("\n")
      .trim();
  } else {
    // Fallback: treat the whole file as content
    console.warn(
      `  [WARN] No --- separator found in: ${filePath} -- using full file as content`,
    );
    content = rawText.trim();
  }

  return { title, sourceUrl, categoryName, content };
}

/**
 * Counts words in a string using whitespace splitting.
 * Strips markdown syntax characters so we count actual words, not punctuation.
 */
function countWords(text: string): number {
  if (!text) return 0;
  return text
    .replace(/[#*`_~[\]()>|]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

// ─── File discovery ───────────────────────────────────────────────────────────

interface ArticleFile {
  absolutePath: string;
  relativePath: string; // relative to articles/
  folderName: string;
  filename: string;
}

/**
 * Recursively walks the articles/ directory and returns all markdown files
 * that should be processed (skipping INDEX files).
 */
function discoverArticleFiles(): ArticleFile[] {
  const results: ArticleFile[] = [];

  if (!fs.existsSync(ARTICLES_DIR)) {
    console.error(`FATAL: articles/ directory not found at: ${ARTICLES_DIR}`);
    process.exit(1);
  }

  const categoryFolders = fs
    .readdirSync(ARTICLES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const folder of categoryFolders) {
    const folderPath = path.join(ARTICLES_DIR, folder.name);

    const files = fs
      .readdirSync(folderPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .filter((entry) => !SKIP_FILENAMES.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const file of files) {
      const absolutePath = path.join(folderPath, file.name);
      const relativePath = path.join(folder.name, file.name);

      results.push({
        absolutePath,
        relativePath,
        folderName: folder.name,
        filename: file.name,
      });
    }
  }

  return results;
}

// ─── Batch upsert ─────────────────────────────────────────────────────────────

async function upsertBatch(
  batch: ArticleInsert[],
): Promise<{ errors: string[] }> {
  const { error } = await supabase
    .from("articles")
    .upsert(batch, { onConflict: "slug", ignoreDuplicates: false });

  if (error) {
    return { errors: [error.message] };
  }
  return { errors: [] };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log(" Shamoun Library -- Article Ingestion Script");
  console.log("=".repeat(60));
  console.log(`Articles directory: ${ARTICLES_DIR}`);
  console.log(`Supabase URL:       ${SUPABASE_URL}`);
  console.log("");

  // 1. Discover files
  const articleFiles = discoverArticleFiles();
  const total = articleFiles.length;
  console.log(`Found ${total} article files to process.\n`);

  // 2. Process each file
  const processed: ArticleInsert[] = [];
  const failures: Array<{ file: string; reason: string }> = [];
  let skippedEmpty = 0;

  for (let i = 0; i < articleFiles.length; i++) {
    const { absolutePath, relativePath, folderName, filename } =
      articleFiles[i];
    const position = i + 1;
    const categoryId = parseCategoryId(folderName);
    const slug = filenameToBaseSlug(filename, categoryId);

    process.stdout.write(
      `[${String(position).padStart(3, " ")}/${total}] Processing: ${slug} ...`,
    );

    // Read file
    let rawText: string;
    try {
      rawText = fs.readFileSync(absolutePath, "utf-8");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(` FAILED (read error)`);
      failures.push({ file: relativePath, reason: `Read error: ${reason}` });
      continue;
    }

    if (!rawText.trim()) {
      console.log(` SKIPPED (empty file)`);
      skippedEmpty++;
      continue;
    }

    // Parse
    let parsed: ParsedArticle;
    try {
      parsed = parseArticleFile(rawText, relativePath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(` FAILED (parse error)`);
      failures.push({ file: relativePath, reason: `Parse error: ${reason}` });
      continue;
    }

    // Render HTML
    let contentHtml: string | null = null;
    try {
      contentHtml = await markdownToHtml(parsed.content);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(` [WARN] HTML render failed: ${reason}`);
      // Non-fatal -- we still insert with null html
    }

    const wordCount = countWords(parsed.content);
    const categorySlug = folderName.replace(/^\d+_/, "").replace(/_/g, "-").toLowerCase();
    const articleOrder = parseArticleOrder(filename);
    const isStub = wordCount < STUB_WORD_THRESHOLD;

    const record: ArticleInsert = {
      slug,
      title: parsed.title,
      category_id: categoryId,
      category_name: parsed.categoryName,
      category_slug: categorySlug,
      source_url: parsed.sourceUrl,
      content: parsed.content,
      content_html: contentHtml,
      word_count: wordCount,
      file_path: relativePath,
      article_order: articleOrder,
      is_stub: isStub,
    };

    processed.push(record);

    const flags = isStub ? " [stub]" : "";
    console.log(` OK (${wordCount} words)${flags}`);
  }

  // 3. Resolve slug collisions using the same order suffix policy as article-loader.
  resolveSlugCollisions(processed);

  // 4. Upsert in batches
  console.log(
    `\nParsed ${processed.length} articles. Upserting to Supabase in batches of ${UPSERT_BATCH_SIZE}...\n`,
  );

  const upsertErrors: Array<{ batch: number; reason: string }> = [];
  const batches = Math.ceil(processed.length / UPSERT_BATCH_SIZE);

  for (let b = 0; b < batches; b++) {
    const start = b * UPSERT_BATCH_SIZE;
    const end = Math.min(start + UPSERT_BATCH_SIZE, processed.length);
    const batch = processed.slice(start, end);

    process.stdout.write(
      `  Batch ${String(b + 1).padStart(3, " ")}/${batches} (articles ${start + 1}-${end}) ...`,
    );

    const { errors } = await upsertBatch(batch);
    if (errors.length > 0) {
      console.log(` FAILED`);
      for (const err of errors) {
        upsertErrors.push({ batch: b + 1, reason: err });
        console.error(`    Error: ${err}`);
      }
    } else {
      console.log(` OK`);
    }
  }

  // 5. Summary
  console.log("\n" + "=".repeat(60));
  console.log(" Ingestion Summary");
  console.log("=".repeat(60));
  console.log(`Total files found:       ${total}`);
  console.log(`Successfully parsed:     ${processed.length}`);
  console.log(`Skipped (empty files):   ${skippedEmpty}`);
  console.log(`Parse failures:          ${failures.length}`);
  console.log(`Upsert batch errors:     ${upsertErrors.length}`);
  console.log(
    `Stub articles (<${STUB_WORD_THRESHOLD} words): ${processed.filter((a) => a.is_stub).length}`,
  );

  if (failures.length > 0) {
    console.log("\nParse failures:");
    for (const f of failures) {
      console.log(`  - ${f.file}: ${f.reason}`);
    }
  }

  if (upsertErrors.length > 0) {
    console.log("\nUpsert errors:");
    for (const e of upsertErrors) {
      console.log(`  - Batch ${e.batch}: ${e.reason}`);
    }
  }

  const totalErrors = failures.length + upsertErrors.length;
  if (totalErrors === 0) {
    console.log("\nIngestion completed successfully.");
  } else {
    console.log(
      `\nIngestion completed with ${totalErrors} error(s). Review logs above.`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nUnhandled error:", err);
  process.exit(1);
});
