import fs from "fs";
import path from "path";
import { CATEGORIES, getCategoryByFolderName } from "./categories";
import { stripMarkdown } from "./strip-markdown";

/**
 * A local article record parsed from the markdown files on disk.
 * Shaped to match the Article interface from src/types/article.ts
 * so the rest of the UI can consume it without changes.
 */
export interface LocalArticle {
	id: string;
	slug: string;
	title: string;
	category_id: number;
	category_name: string;
	category_slug: string;
	source_url: string | null;
	content: string;
	word_count: number;
	file_path: string;
	article_order: number;
}

// Module-level cache -- populated once per build/process lifetime.
let _cache: LocalArticle[] | null = null;
let _slugMap: Map<string, LocalArticle> | null = null;

const ARTICLES_DIR = path.join(process.cwd(), "articles");

/**
 * Parse a single markdown file into a LocalArticle.
 * Returns null when the file cannot be parsed (index files, stubs, etc.).
 */
function parseMarkdownFile(
	filePath: string,
	folderName: string,
	fileName: string,
): LocalArticle | null {
	// Skip index files and the master index
	if (
		fileName.startsWith("00_INDEX") ||
		fileName === "00_MASTER_INDEX.md" ||
		!fileName.endsWith(".md")
	) {
		return null;
	}

	const category = getCategoryByFolderName(folderName);
	if (!category) return null;

	// Derive article_order from the numeric prefix in the filename (e.g. "001")
	const orderMatch = fileName.match(/^(\d+)_/);
	const article_order = orderMatch ? parseInt(orderMatch[1], 10) : 0;

	// Build a slug from the filename without the numeric prefix and extension
	const slugRaw = fileName
		.replace(/^\d+_/, "")
		.replace(/\.md$/, "")
		// Normalise common punctuation that appears in filenames
		.replace(/[^\w-]/g, "-")
		.replace(/-{2,}/g, "-")
		.toLowerCase();
	const slug = `${category.id}-${slugRaw}`;

	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}

	const lines = raw.split("\n");

	// Title: first H1 heading
	let title = slug;
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("# ")) {
			title = trimmed.slice(2).trim();
			break;
		}
	}

	// Source URL: **Source:** [label](url)
	let source_url: string | null = null;
	for (const line of lines) {
		const m = line.match(/\*\*Source:\*\*\s*\[.*?\]\((.*?)\)/);
		if (m) {
			source_url = m[1];
			break;
		}
	}

	// Content: everything after the "---" separator
	const separatorIdx = lines.findIndex((l) => l.trim() === "---");
	const content =
		separatorIdx !== -1
			? lines
					.slice(separatorIdx + 1)
					.join("\n")
					.trim()
			: raw.trim();

	// Rough word count on the full file (title + content)
	const word_count = raw.split(/\s+/).filter((w) => w.length > 0).length;

	return {
		id: slug,
		slug,
		title,
		category_id: category.id,
		category_name: category.name,
		category_slug: category.slug,
		source_url,
		content,
		word_count,
		file_path: filePath,
		article_order,
	};
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

function resolveSlugCollisions(articles: LocalArticle[]): void {
	const bySlug = new Map<string, LocalArticle[]>();
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
			if (a.article_order !== b.article_order) {
				return a.article_order - b.article_order;
			}
			return a.file_path.localeCompare(b.file_path);
		});

		for (const article of sorted) {
			const uniqueSlug = makeUniqueSlug(slug, article.article_order, usedSlugs);
			article.slug = uniqueSlug;
			article.id = uniqueSlug;
			usedSlugs.add(uniqueSlug);
		}
	}
}

/**
 * Read all local markdown articles from disk and cache the result.
 * Subsequent calls in the same process return the cached array immediately.
 */
export function getAllArticles(): LocalArticle[] {
	if (_cache) return _cache;

	const articles: LocalArticle[] = [];

	// Iterate category folders in order
	for (const category of CATEGORIES) {
		// Map category id to the zero-padded folder prefix
		const paddedId = String(category.id).padStart(2, "0");
		// Find the matching folder (slug may differ slightly from folder name)
		const folders = fs
			.readdirSync(ARTICLES_DIR)
			.filter((f) => f.startsWith(`${paddedId}_`));

		for (const folderName of folders) {
			const folderPath = path.join(ARTICLES_DIR, folderName);
			const stat = fs.statSync(folderPath);
			if (!stat.isDirectory()) continue;

			const files = fs.readdirSync(folderPath).sort();
			for (const fileName of files) {
				const filePath = path.join(folderPath, fileName);
				const article = parseMarkdownFile(filePath, folderName, fileName);
				if (article) articles.push(article);
			}
		}
	}

	resolveSlugCollisions(articles);
	_cache = articles;
	return articles;
}

/**
 * A lightweight article summary without the full content field.
 * Used for listing pages (categories, search results) to avoid serializing
 * megabytes of markdown through the Server Component payload.
 */
export interface ArticleSummary {
	id: string;
	slug: string;
	title: string;
	category_id: number;
	category_name: string;
	category_slug: string;
	source_url: string | null;
	word_count: number;
	article_order: number;
	excerpt: string;
}

/**
 * Return all articles that belong to a specific category.
 */
export function getArticlesByCategory(categoryId: number): LocalArticle[] {
	return getAllArticles().filter((a) => a.category_id === categoryId);
}

/**
 * Return lightweight article summaries for a category, without full content.
 * This avoids serializing full article bodies through the RSC payload on
 * listing pages, preventing 500 errors on categories with many articles.
 */
export function getArticleSummariesByCategory(
	categoryId: number,
): ArticleSummary[] {
	return getArticlesByCategory(categoryId).map((a) => ({
		id: a.id,
		slug: a.slug,
		title: a.title,
		category_id: a.category_id,
		category_name: a.category_name,
		category_slug: a.category_slug,
		source_url: a.source_url,
		word_count: a.word_count,
		article_order: a.article_order,
		excerpt: getExcerpt(a.content, 150),
	}));
}

/**
 * Return lightweight summaries for ALL articles, without full content.
 */
export function getAllArticleSummaries(): ArticleSummary[] {
	return getAllArticles().map((a) => ({
		id: a.id,
		slug: a.slug,
		title: a.title,
		category_id: a.category_id,
		category_name: a.category_name,
		category_slug: a.category_slug,
		source_url: a.source_url,
		word_count: a.word_count,
		article_order: a.article_order,
		excerpt: getExcerpt(a.content, 150),
	}));
}

/**
 * Find a single article by its slug.
 */
export function getArticleBySlug(slug: string): LocalArticle | undefined {
	if (!_slugMap) {
		_slugMap = new Map(getAllArticles().map((a) => [a.slug, a]));
	}
	return _slugMap.get(slug);
}

/**
 * Return the first N characters of article content, stripped of markdown
 * formatting characters, suitable for use as an excerpt.
 */
export function getExcerpt(content: string, maxChars = 150): string {
	// Remove markdown headings, bold/italic markers, links, and inline code
	const stripped = stripMarkdown(content);

	if (stripped.length <= maxChars) return stripped;
	const cut = stripped.slice(0, maxChars);
	// Trim to last full word
	const lastSpace = cut.lastIndexOf(" ");
	return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + "…";
}

/**
 * Estimate reading time in minutes given a word count.
 * Assumes 200 wpm average reading speed.
 */
export function estimateReadTime(wordCount: number): number {
	return Math.max(1, Math.round(wordCount / 200));
}
