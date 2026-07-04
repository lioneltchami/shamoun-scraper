import * as dotenv from "dotenv";
import * as path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { getAllArticleSummaries } from "../src/lib/article-loader";
import { CATEGORIES } from "../src/lib/categories";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

interface DbArticle {
	slug: string;
	title: string | null;
	category_id: number | null;
	category_name: string | null;
	category_slug: string | null;
	word_count: number | null;
	content: string | null;
	is_stub: boolean | null;
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

function printSample(label: string, values: string[]): void {
	if (values.length === 0) return;

	console.log(`${label}:`);
	for (const value of values.slice(0, 20)) {
		console.log(`  - ${value}`);
	}
}

const supabaseUrl = requireEnv("SUPABASE_URL");
const supabaseServiceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
	auth: {
		autoRefreshToken: false,
		persistSession: false,
		detectSessionInUrl: false,
	},
});

const PAGE_SIZE = 1000;

async function fetchDbArticles(): Promise<DbArticle[]> {
	const rows: DbArticle[] = [];

	for (let from = 0; ; from += PAGE_SIZE) {
		const to = from + PAGE_SIZE - 1;
		const { data, error } = await supabase
			.from("articles")
			.select(
				"slug, title, category_id, category_name, category_slug, word_count, content, is_stub",
			)
			// Use a unique, stable order for paginated reads so range() cannot
			// duplicate or skip rows within large same-category groups.
			.order("slug", { ascending: true })
			.range(from, to)
			.returns<DbArticle[]>();

		if (error) {
			throw new Error(`Failed to fetch Supabase articles: ${error.message}`);
		}

		rows.push(...(data ?? []));

		if (!data || data.length < PAGE_SIZE) {
			return rows;
		}
	}
}

const localArticles = getAllArticleSummaries();
const localSlugs = new Set<string>(localArticles.map((article) => article.slug));

const dbRows = await fetchDbArticles();

const dbCategoryCount = new Set(
	dbRows
		.map((article) => article.category_id)
		.filter((categoryId): categoryId is number => categoryId !== null),
).size;

const dbSlugs = new Set<string>(dbRows.map((article) => article.slug));

const onlyLocal = [...localSlugs]
	.filter((slug) => !dbSlugs.has(slug))
	.sort((a, b) => a.localeCompare(b));
const onlyDb = [...dbSlugs]
	.filter((slug) => !localSlugs.has(slug))
	.sort((a, b) => a.localeCompare(b));
const emptyNonStubDb = dbRows
	.filter(
		(article) =>
			!article.is_stub && (!article.content || article.content.trim().length === 0),
	)
	.map((article) => article.slug)
	.sort((a, b) => a.localeCompare(b));
const emptyStubDb = dbRows
	.filter(
		(article) =>
			article.is_stub && (!article.content || article.content.trim().length === 0),
	)
	.map((article) => article.slug)
	.sort((a, b) => a.localeCompare(b));

console.log("Content contract audit");
console.log("----------------------");
console.log(`Local article summaries: ${localArticles.length}`);
console.log(`Supabase article rows: ${dbRows.length}`);
console.log(`Local categories: ${CATEGORIES.length}`);
console.log(`Supabase categories: ${dbCategoryCount}`);
console.log(`Only-local count: ${onlyLocal.length}`);
console.log(`Only-Supabase count: ${onlyDb.length}`);
console.log(`Empty non-stub content count: ${emptyNonStubDb.length}`);
console.log(`Empty stub placeholder count: ${emptyStubDb.length}`);

printSample("First 20 only-local slugs", onlyLocal);
printSample("First 20 only-Supabase slugs", onlyDb);
printSample("First 20 empty non-stub Supabase slugs", emptyNonStubDb);
printSample("First 20 empty stub placeholder Supabase slugs", emptyStubDb);

if (onlyLocal.length > 0 || onlyDb.length > 0 || emptyNonStubDb.length > 0) {
	console.log(
		"\nLocal scraped content and Supabase are out of sync. Re-run `npm run db:ingest` and inspect the reported slug differences above.",
	);
	process.exitCode = 1;
}
