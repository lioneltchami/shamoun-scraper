/**
 * generate-embeddings.ts
 *
 * Chunks all non-stub articles and generates OpenAI text-embedding-3-small
 * embeddings, inserting them into the article_chunks table in Supabase.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OPENAI_API_KEY=... npx tsx scripts/generate-embeddings.ts
 *   Add --force to regenerate all embeddings.
 *
 * The script is resumable: articles that already have rows in article_chunks
 * are skipped automatically.
 */

import { createClient } from "@supabase/supabase-js";

// Inline chunker to avoid importing from src/ (which triggers tsx to transpile the entire tree)
type ArticleChunk = { content: string; tokenCount: number; chunkIndex: number };

const MAX_CHUNK_TOKENS = 700;

function estimateTokens(text: string): number {
	return Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.3);
}

function splitIntoParagraphs(text: string): string[] {
	return text.split(/\n\n+/).map((p) => p.trim()).filter((p) => p.length > 0);
}

function splitLongText(text: string, targetMax: number): string[] {
	const words = text.trim().split(/\s+/).filter(Boolean);
	const maxWords = Math.max(1, Math.floor(targetMax / 1.3));
	const chunks: string[] = [];

	for (let i = 0; i < words.length; i += maxWords) {
		chunks.push(words.slice(i, i + maxWords).join(" "));
	}

	return chunks;
}

function mergeIntoChunks(paragraphs: string[], targetMax: number): string[] {
	const chunks: string[] = [];
	let current: string[] = [];
	let tokens = 0;
	for (const p of paragraphs) {
		const pt = estimateTokens(p);
		if (pt > targetMax) {
			if (current.length > 0) {
				chunks.push(current.join("\n\n"));
				current = [];
				tokens = 0;
			}
			chunks.push(...splitLongText(p, targetMax));
			continue;
		}
		if (tokens + pt > targetMax && current.length > 0) {
			chunks.push(current.join("\n\n"));
			current = [];
			tokens = 0;
		}
		current.push(p);
		tokens += pt;
	}
	if (current.length > 0) chunks.push(current.join("\n\n"));
	return chunks;
}

function chunkArticle(title: string, content: string): ArticleChunk[] {
	const words = content.trim().split(/\s+/).filter(Boolean).length;
	let rawChunks: string[];
	if (words < 200) {
		rawChunks = mergeIntoChunks(splitIntoParagraphs(content), MAX_CHUNK_TOKENS);
		if (rawChunks.length === 0) rawChunks = [content.trim()];
	} else if (words < 2000) {
		rawChunks = mergeIntoChunks(splitIntoParagraphs(content), 600);
		if (rawChunks.length === 0) rawChunks = [content.trim()];
	} else {
		rawChunks = mergeIntoChunks(splitIntoParagraphs(content), MAX_CHUNK_TOKENS);
		if (rawChunks.length === 0) rawChunks = [content.trim()];
	}

	const boundedChunks = rawChunks.flatMap((raw) => {
		const prefixed = `[${title}] - ${raw.trim()}`;
		return estimateTokens(prefixed) > MAX_CHUNK_TOKENS
			? splitLongText(raw, MAX_CHUNK_TOKENS)
			: [raw];
	});

	return boundedChunks.map((raw, i) => {
		const prefixed = `[${title}] - ${raw.trim()}`;
		return { content: prefixed, tokenCount: estimateTokens(prefixed), chunkIndex: i };
	});
}

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OPENAI_API_KEY) {
	console.error(
		"Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY",
	);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

// Inline admin client so the script is self-contained even if
// src/lib/supabase/admin.ts does not yet exist. If it does exist you can
// swap this import:
//   import { supabaseAdmin } from "../src/lib/supabase/admin";
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
	auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMBEDDING_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 50; // chunks per OpenAI request
const BATCH_DELAY_MS = 500; // pause between batches
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 5_000; // 5s, 10s, 20s exponential
const FORCE = process.argv.includes("--force");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Article {
	id: string;
	title: string;
	slug: string;
	content: string;
	is_stub: boolean;
}

interface ChunkRow {
	article_id: string;
	chunk_index: number;
	content: string;
	token_count: number;
	embedding: number[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate embeddings for a batch of texts with exponential backoff on 429.
 * Returns the embedding vectors in the same order as the input texts.
 */
async function generateEmbeddingsWithRetry(
	texts: string[],
): Promise<number[][]> {
	let attempt = 0;

	while (attempt < MAX_RETRIES) {
		try {
			const response = await fetch("https://api.openai.com/v1/embeddings", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${OPENAI_API_KEY}`,
				},
				body: JSON.stringify({
					model: EMBEDDING_MODEL,
					input: texts,
					dimensions: 1536,
				}),
			});

			if (response.status === 429 && attempt < MAX_RETRIES - 1) {
				const waitMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
				console.warn(`  Rate limited (429). Waiting ${waitMs / 1000}s...`);
				await sleep(waitMs);
				attempt++;
				continue;
			}

			if (!response.ok) {
				const body = await response.text();
				throw new Error(`OpenAI API error ${response.status}: ${body}`);
			}

			const json = await response.json() as {
				data: Array<{ index: number; embedding: number[] }>;
			};

			return json.data
				.sort((a, b) => a.index - b.index)
				.map((item) => item.embedding);
		} catch (error: unknown) {
			if (attempt < MAX_RETRIES - 1) {
				attempt++;
				continue;
			}
			throw error;
		}
	}

	throw new Error("Max retries exceeded");
}

/**
 * Fetch IDs of articles that already have chunks in article_chunks.
 * Paginates in batches of 1000 to avoid the default row cap.
 * Returns a Set of article UUIDs.
 */
async function fetchArticlesWithExistingChunks(): Promise<Set<string>> {
	const existingArticleIds = new Set<string>();
	let from = 0;
	const pageSize = 1000;

	while (true) {
		const { data, error } = await supabaseAdmin
			.from("article_chunks")
			.select("article_id")
			.range(from, from + pageSize - 1);

		if (error) {
			throw new Error(`Failed to fetch existing chunks: ${error.message}`);
		}

		if (!data || data.length === 0) break;
		data.forEach((row) => existingArticleIds.add(row.article_id as string));
		if (data.length < pageSize) break;
		from += pageSize;
	}

	return existingArticleIds;
}

/**
 * Fetch articles from Supabase in pages, returning only IDs and metadata.
 * Content is fetched per-article during processing to avoid loading everything into memory.
 */
async function fetchArticleList(): Promise<Array<{ id: string; slug: string; is_stub: boolean }>> {
	const all: Array<{ id: string; slug: string; is_stub: boolean }> = [];
	let from = 0;
	const pageSize = 500;

	while (true) {
		const { data, error } = await supabaseAdmin
			.from("articles")
			.select("id, slug, is_stub")
			.order("slug")
			.range(from, from + pageSize - 1);

		if (error) throw new Error(`Failed to fetch articles: ${error.message}`);
		if (!data || data.length === 0) break;
		all.push(...(data as Array<{ id: string; slug: string; is_stub: boolean }>));
		if (data.length < pageSize) break;
		from += pageSize;
	}

	return all;
}

/**
 * Fetch a single article's content by ID.
 */
async function fetchArticleContent(id: string): Promise<{ id: string; title: string; slug: string; content: string } | null> {
	const { data, error } = await supabaseAdmin
		.from("articles")
		.select("id, title, slug, content")
		.eq("id", id)
		.single();

	if (error) {
		throw new Error(`Failed to fetch article content: ${error.message}`);
	}
	return data as { id: string; title: string; slug: string; content: string };
}

/**
 * Insert a batch of chunk rows into article_chunks.
 */
async function insertChunkRows(rows: ChunkRow[]): Promise<void> {
	const { error } = await supabaseAdmin.from("article_chunks").insert(rows);

	if (error) {
		throw new Error(`Failed to insert chunk rows: ${error.message}`);
	}
}

/**
 * Process a single article: chunk it, batch-embed the chunks, and insert
 * all rows into article_chunks in one go (per article).
 *
 * Returns the number of chunks created, or throws on failure.
 */
async function processArticle(article: Article): Promise<number> {
	if (FORCE) {
		await supabaseAdmin.from("article_chunks").delete().eq("article_id", article.id);
	}

	const chunks: ArticleChunk[] = chunkArticle(article.title, article.content);

	if (chunks.length === 0) {
		console.warn(`  No chunks produced for "${article.slug}" - skipping.`);
		return 0;
	}

	const chunkTexts = chunks.map((c) => c.content);
	const chunkRows: ChunkRow[] = [];

	// Process chunks in batches of BATCH_SIZE
	for (
		let batchStart = 0;
		batchStart < chunkTexts.length;
		batchStart += BATCH_SIZE
	) {
		const batchTexts = chunkTexts.slice(batchStart, batchStart + BATCH_SIZE);
		const batchChunks = chunks.slice(batchStart, batchStart + BATCH_SIZE);

		const embeddings = await generateEmbeddingsWithRetry(batchTexts);

		for (let j = 0; j < batchChunks.length; j++) {
			chunkRows.push({
				article_id: article.id,
				chunk_index: batchChunks[j].chunkIndex,
				content: batchChunks[j].content,
				token_count: batchChunks[j].tokenCount,
				embedding: embeddings[j],
			});
		}

		// Delay between batches to avoid hammering the rate limit
		if (batchStart + BATCH_SIZE < chunkTexts.length) {
			await sleep(BATCH_DELAY_MS);
		}
	}

	await insertChunkRows(chunkRows);
	return chunkRows.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log("=== Embedding Generation Script ===");
	console.log(`Model: ${EMBEDDING_MODEL} (1536 dimensions)`);
	console.log(`Batch size: ${BATCH_SIZE} chunks`);
	console.log(`Batch delay: ${BATCH_DELAY_MS}ms`);
	if (FORCE) console.log("⚠️  --force mode: regenerating all embeddings");
	console.log("");

	// 1. Fetch article list (lightweight — no content)
	console.log("Fetching article list from Supabase...");
	const articleList = await fetchArticleList();
	console.log(`Found ${articleList.length} total articles.`);

	// 2. Filter out stubs
	const nonStubs = articleList.filter((a) => !a.is_stub);
	const stubCount = articleList.length - nonStubs.length;
	if (stubCount > 0) console.log(`Skipping ${stubCount} stub articles.`);

	// 3. Find articles that already have chunks (for resumability)
	console.log("Checking for already-processed articles...");
	const alreadyProcessed = FORCE ? new Set<string>() : await fetchArticlesWithExistingChunks();
	const toProcess = nonStubs.filter((a) => !alreadyProcessed.has(a.id));

	console.log(`Already processed: ${alreadyProcessed.size} articles`);
	console.log(`To process: ${toProcess.length} articles`);
	console.log("");

	if (toProcess.length === 0) {
		console.log("Nothing to do - all articles already have embeddings.");
		return;
	}

	// 4. Process each article ONE AT A TIME (fetch content, chunk, embed, insert, release)
	const total = toProcess.length;
	let totalChunksCreated = 0;
	const failures: Array<{ slug: string; error: string }> = [];

	for (let i = 0; i < total; i++) {
		const { id, slug } = toProcess[i];
		const label = `[${i + 1}/${total}] ${slug}`;

		try {
			// Fetch content for just this one article
			const article = await fetchArticleContent(id);
			if (!article) {
				throw new Error("Failed to fetch article content");
			}

			const chunksCreated = await processArticle(article as Article);
			totalChunksCreated += chunksCreated;
			console.log(`${label}: ${chunksCreated} chunks`);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`${label}: FAILED - ${message}`);
			failures.push({ slug, error: message });
		}
	}

	// 5. Summary
	console.log("");
	console.log("=== Summary ===");
	console.log(`Articles processed: ${total - failures.length}/${total}`);
	console.log(`Total chunks created: ${totalChunksCreated}`);

	if (failures.length > 0) {
		console.log(`\nFailed articles (${failures.length}):`);
		for (const f of failures) {
			console.log(`  - ${f.slug}: ${f.error}`);
		}
		console.log(
			"\nRe-run the script to retry failed articles (already-successful articles will be skipped).",
		);
		process.exit(1);
	} else {
		console.log("\nAll articles processed successfully.");
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
