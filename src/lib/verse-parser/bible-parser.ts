/**
 * bible-parser.ts
 *
 * Extracts Bible verse references from free-form article text.
 *
 * Design goals:
 *   - Match all 66 canonical books with full names and common abbreviations.
 *   - Handle books whose names start with a number ("1 Corinthians", "2 Kings").
 *   - Handle multi-word book names ("Song of Solomon", "Song of Songs").
 *   - Capture verse ranges (John 1:1-3) and single verses (John 1:1).
 *   - Normalize every matched abbreviation to the full canonical book name.
 *   - Never produce false positives from numeric substrings inside larger words.
 *   - Return testament classification (OT / NT) for every match.
 *
 * Regex strategy:
 *   A single compiled regex with a large alternation group covering every
 *   recognized book name/abbreviation. The book-name group is followed by
 *   optional whitespace, a chapter number, a colon, a verse-start number,
 *   and an optional "-verseEnd" range.
 *
 *   The alternation is ordered from longest to shortest within each group
 *   so that "1 Corinthians" matches before "1 Cor", and "Song of Solomon"
 *   matches before "Song". This prevents partial matches.
 *
 *   A word-boundary assertion is applied after the book name to avoid matching
 *   "Genesis" inside "Genesisology", but the assertion is pattern-specific
 *   because some abbreviations end with a period (e.g. "Gen.").
 */

import type { BibleVerseRef } from "../../types/verse";

// ---------------------------------------------------------------------------
// Testament classification
// ---------------------------------------------------------------------------

/**
 * Maps each canonical book name to its testament.
 * This is the authoritative source for OT/NT classification.
 */
export const BOOKS_BY_TESTAMENT: Record<string, "OT" | "NT"> = {
	// Old Testament
	Genesis: "OT",
	Exodus: "OT",
	Leviticus: "OT",
	Numbers: "OT",
	Deuteronomy: "OT",
	Joshua: "OT",
	Judges: "OT",
	Ruth: "OT",
	"1 Samuel": "OT",
	"2 Samuel": "OT",
	"1 Kings": "OT",
	"2 Kings": "OT",
	"1 Chronicles": "OT",
	"2 Chronicles": "OT",
	Ezra: "OT",
	Nehemiah: "OT",
	Esther: "OT",
	Job: "OT",
	Psalms: "OT",
	Proverbs: "OT",
	Ecclesiastes: "OT",
	"Song of Solomon": "OT",
	Isaiah: "OT",
	Jeremiah: "OT",
	Lamentations: "OT",
	Ezekiel: "OT",
	Daniel: "OT",
	Hosea: "OT",
	Joel: "OT",
	Amos: "OT",
	Obadiah: "OT",
	Jonah: "OT",
	Micah: "OT",
	Nahum: "OT",
	Habakkuk: "OT",
	Zephaniah: "OT",
	Haggai: "OT",
	Zechariah: "OT",
	Malachi: "OT",

	// New Testament
	Matthew: "NT",
	Mark: "NT",
	Luke: "NT",
	John: "NT",
	Acts: "NT",
	Romans: "NT",
	"1 Corinthians": "NT",
	"2 Corinthians": "NT",
	Galatians: "NT",
	Ephesians: "NT",
	Philippians: "NT",
	Colossians: "NT",
	"1 Thessalonians": "NT",
	"2 Thessalonians": "NT",
	"1 Timothy": "NT",
	"2 Timothy": "NT",
	Titus: "NT",
	Philemon: "NT",
	Hebrews: "NT",
	James: "NT",
	"1 Peter": "NT",
	"2 Peter": "NT",
	"1 John": "NT",
	"2 John": "NT",
	"3 John": "NT",
	Jude: "NT",
	Revelation: "NT",
};

// ---------------------------------------------------------------------------
// Abbreviation map: abbreviation -> canonical full name
//
// Keys are the raw strings that appear in article text (case-sensitive as
// authors write them). The regex alternation is built from these keys plus
// the canonical names listed above.
//
// Ordering rule within each canonical name: longest abbreviation first so
// the regex engine matches greedily without backtracking into a shorter alias.
// ---------------------------------------------------------------------------

const ABBREVIATION_MAP: Record<string, string> = {
	// Genesis
	Gen: "Genesis",
	"Gen.": "Genesis",

	// Exodus
	Exod: "Exodus",
	"Exod.": "Exodus",
	Exo: "Exodus",
	"Exo.": "Exodus",
	Ex: "Exodus",
	"Ex.": "Exodus",

	// Leviticus
	Lev: "Leviticus",
	"Lev.": "Leviticus",

	// Numbers
	Num: "Numbers",
	"Num.": "Numbers",
	Numb: "Numbers",
	"Numb.": "Numbers",

	// Deuteronomy
	Deut: "Deuteronomy",
	"Deut.": "Deuteronomy",
	Dt: "Deuteronomy",

	// Joshua
	Josh: "Joshua",
	"Josh.": "Joshua",
	Jos: "Joshua",

	// Judges
	Judg: "Judges",
	"Judg.": "Judges",
	Jdg: "Judges",
	Jg: "Judges",

	// Ruth
	Ru: "Ruth",

	// 1 Samuel
	"1 Sam": "1 Samuel",
	"1 Sam.": "1 Samuel",
	"1Sam": "1 Samuel",
	"1Sa": "1 Samuel",
	"1 Sa": "1 Samuel",
	"I Sam": "1 Samuel",
	"I Samuel": "1 Samuel",
	"I Sa": "1 Samuel",

	// 2 Samuel
	"2 Sam": "2 Samuel",
	"2 Sam.": "2 Samuel",
	"2Sam": "2 Samuel",
	"2Sa": "2 Samuel",
	"2 Sa": "2 Samuel",
	"II Sam": "2 Samuel",
	"II Samuel": "2 Samuel",
	"II Sa": "2 Samuel",

	// 1 Kings
	"1 Kgs": "1 Kings",
	"1 Kgs.": "1 Kings",
	"1Kgs": "1 Kings",
	"1 Ki": "1 Kings",
	"1Ki": "1 Kings",
	"I Kings": "1 Kings",
	"I Kgs": "1 Kings",
	"I Ki": "1 Kings",

	// 2 Kings
	"2 Kgs": "2 Kings",
	"2 Kgs.": "2 Kings",
	"2Kgs": "2 Kings",
	"2 Ki": "2 Kings",
	"2Ki": "2 Kings",
	"II Kings": "2 Kings",
	"II Kgs": "2 Kings",
	"II Ki": "2 Kings",

	// 1 Chronicles
	"1 Chr": "1 Chronicles",
	"1 Chr.": "1 Chronicles",
	"1Chr": "1 Chronicles",
	"1 Chron": "1 Chronicles",
	"1Chron": "1 Chronicles",
	"I Chr": "1 Chronicles",
	"I Chronicles": "1 Chronicles",
	"I Chron": "1 Chronicles",

	// 2 Chronicles
	"2 Chr": "2 Chronicles",
	"2 Chr.": "2 Chronicles",
	"2Chr": "2 Chronicles",
	"2 Chron": "2 Chronicles",
	"2Chron": "2 Chronicles",
	"II Chr": "2 Chronicles",
	"II Chronicles": "2 Chronicles",
	"II Chron": "2 Chronicles",

	// Ezra
	Ezr: "Ezra",

	// Nehemiah
	Neh: "Nehemiah",
	"Neh.": "Nehemiah",

	// Esther
	Est: "Esther",
	"Est.": "Esther",
	Esth: "Esther",
	"Esth.": "Esther",

	// Job
	// No common abbreviation distinct enough to add without false positives.

	// Psalms
	Ps: "Psalms",
	"Ps.": "Psalms",
	Pss: "Psalms",
	"Pss.": "Psalms",
	Psalm: "Psalms",
	Psa: "Psalms",
	"Psa.": "Psalms",

	// Proverbs
	Prov: "Proverbs",
	"Prov.": "Proverbs",
	Pro: "Proverbs",
	"Pro.": "Proverbs",
	Pr: "Proverbs",

	// Ecclesiastes
	Eccl: "Ecclesiastes",
	"Eccl.": "Ecclesiastes",
	Ecc: "Ecclesiastes",
	Eccles: "Ecclesiastes",
	Qoh: "Ecclesiastes",

	// Song of Solomon / Song of Songs / Canticles
	"Song of Songs": "Song of Solomon",
	"Song of Sol": "Song of Solomon",
	"Song of Sol.": "Song of Solomon",
	"Song of Song": "Song of Solomon",
	"Sg of Sol": "Song of Solomon",
	Canticles: "Song of Solomon",
	Cant: "Song of Solomon",
	"Cant.": "Song of Solomon",
	SOS: "Song of Solomon",
	SS: "Song of Solomon",
	Song: "Song of Solomon",

	// Isaiah
	Isa: "Isaiah",
	"Isa.": "Isaiah",
	Is: "Isaiah",

	// Jeremiah
	Jer: "Jeremiah",
	"Jer.": "Jeremiah",

	// Lamentations
	Lam: "Lamentations",
	"Lam.": "Lamentations",

	// Ezekiel
	Ezek: "Ezekiel",
	"Ezek.": "Ezekiel",
	Eze: "Ezekiel",
	"Eze.": "Ezekiel",
	Ezk: "Ezekiel",

	// Daniel
	Dan: "Daniel",
	"Dan.": "Daniel",
	Dn: "Daniel",

	// Hosea
	Hos: "Hosea",
	"Hos.": "Hosea",

	// Joel
	Jl: "Joel",

	// Amos
	// "Am" alone risks colliding with English words; skip.

	// Obadiah
	Obad: "Obadiah",
	"Obad.": "Obadiah",
	Ob: "Obadiah",

	// Jonah
	Jon: "Jonah",
	"Jon.": "Jonah",
	Jnh: "Jonah",

	// Micah
	Mic: "Micah",
	"Mic.": "Micah",
	Mi: "Micah",

	// Nahum
	Nah: "Nahum",
	"Nah.": "Nahum",
	Na: "Nahum",

	// Habakkuk
	Hab: "Habakkuk",
	"Hab.": "Habakkuk",
	Hb: "Habakkuk",

	// Zephaniah
	Zeph: "Zephaniah",
	"Zeph.": "Zephaniah",
	Zep: "Zephaniah",
	Zp: "Zephaniah",

	// Haggai
	Hag: "Haggai",
	"Hag.": "Haggai",
	Hg: "Haggai",

	// Zechariah
	Zech: "Zechariah",
	"Zech.": "Zechariah",
	Zec: "Zechariah",
	Zc: "Zechariah",

	// Malachi
	Mal: "Malachi",
	"Mal.": "Malachi",
	Ml: "Malachi",

	// -----------------------------------------------------------------------
	// New Testament abbreviations
	// -----------------------------------------------------------------------

	// Matthew
	Matt: "Matthew",
	"Matt.": "Matthew",
	Mt: "Matthew",
	"Mt.": "Matthew",

	// Mark
	Mk: "Mark",
	"Mk.": "Mark",
	Mr: "Mark",
	"Mr.": "Mark",
	Mrk: "Mark",
	"Mrk.": "Mark",

	// Luke
	Lk: "Luke",
	"Lk.": "Luke",
	Lu: "Luke",
	"Lu.": "Luke",
	Luk: "Luke",
	"Luk.": "Luke",

	// John
	Jn: "John",
	"Jn.": "John",
	Joh: "John",
	"Joh.": "John",
	Jno: "John",

	// Acts
	// Full word "Acts" is in the canonical list; no separate abbreviations needed.
	Ac: "Acts",
	"Ac.": "Acts",

	// Romans
	Rom: "Romans",
	"Rom.": "Romans",
	Ro: "Romans",
	"Ro.": "Romans",
	Rm: "Romans",

	// 1 Corinthians
	"1 Cor": "1 Corinthians",
	"1 Cor.": "1 Corinthians",
	"1Cor": "1 Corinthians",
	"1Co": "1 Corinthians",
	"1 Co": "1 Corinthians",
	"I Cor": "1 Corinthians",
	"I Corinthians": "1 Corinthians",
	"I Co": "1 Corinthians",

	// 2 Corinthians
	"2 Cor": "2 Corinthians",
	"2 Cor.": "2 Corinthians",
	"2Cor": "2 Corinthians",
	"2Co": "2 Corinthians",
	"2 Co": "2 Corinthians",
	"II Cor": "2 Corinthians",
	"II Corinthians": "2 Corinthians",
	"II Co": "2 Corinthians",

	// Galatians
	Gal: "Galatians",
	"Gal.": "Galatians",
	Ga: "Galatians",

	// Ephesians
	Eph: "Ephesians",
	"Eph.": "Ephesians",
	Ephes: "Ephesians",

	// Philippians
	Phil: "Philippians",
	"Phil.": "Philippians",
	Php: "Philippians",
	Pp: "Philippians",

	// Colossians
	Col: "Colossians",
	"Col.": "Colossians",

	// 1 Thessalonians
	"1 Thess": "1 Thessalonians",
	"1 Thess.": "1 Thessalonians",
	"1Thess": "1 Thessalonians",
	"1 Thes": "1 Thessalonians",
	"1Thes": "1 Thessalonians",
	"1 Th": "1 Thessalonians",
	"1Th": "1 Thessalonians",
	"I Thess": "1 Thessalonians",
	"I Thessalonians": "1 Thessalonians",
	"I Thes": "1 Thessalonians",
	"I Th": "1 Thessalonians",

	// 2 Thessalonians
	"2 Thess": "2 Thessalonians",
	"2 Thess.": "2 Thessalonians",
	"2Thess": "2 Thessalonians",
	"2 Thes": "2 Thessalonians",
	"2Thes": "2 Thessalonians",
	"2 Th": "2 Thessalonians",
	"2Th": "2 Thessalonians",
	"II Thess": "2 Thessalonians",
	"II Thessalonians": "2 Thessalonians",
	"II Thes": "2 Thessalonians",
	"II Th": "2 Thessalonians",

	// 1 Timothy
	"1 Tim": "1 Timothy",
	"1 Tim.": "1 Timothy",
	"1Tim": "1 Timothy",
	"1Ti": "1 Timothy",
	"1 Ti": "1 Timothy",
	"I Tim": "1 Timothy",
	"I Timothy": "1 Timothy",
	"I Ti": "1 Timothy",

	// 2 Timothy
	"2 Tim": "2 Timothy",
	"2 Tim.": "2 Timothy",
	"2Tim": "2 Timothy",
	"2Ti": "2 Timothy",
	"2 Ti": "2 Timothy",
	"II Tim": "2 Timothy",
	"II Timothy": "2 Timothy",
	"II Ti": "2 Timothy",

	// Titus
	Tit: "Titus",
	"Tit.": "Titus",
	Ti: "Titus",

	// Philemon
	Phlm: "Philemon",
	"Phlm.": "Philemon",
	Phm: "Philemon",
	"Phm.": "Philemon",

	// Hebrews
	Heb: "Hebrews",
	"Heb.": "Hebrews",

	// James
	Jas: "James",
	"Jas.": "James",
	Jm: "James",

	// 1 Peter
	"1 Pet": "1 Peter",
	"1 Pet.": "1 Peter",
	"1Pet": "1 Peter",
	"1Pe": "1 Peter",
	"1 Pe": "1 Peter",
	"I Pet": "1 Peter",
	"I Peter": "1 Peter",
	"I Pe": "1 Peter",

	// 2 Peter
	"2 Pet": "2 Peter",
	"2 Pet.": "2 Peter",
	"2Pet": "2 Peter",
	"2Pe": "2 Peter",
	"2 Pe": "2 Peter",
	"II Pet": "2 Peter",
	"II Peter": "2 Peter",
	"II Pe": "2 Peter",

	// 1 John (IMPORTANT: must appear before plain "John" in the regex alternation)
	"1 Jn": "1 John",
	"1 Jn.": "1 John",
	"1Jn": "1 John",
	"1 Joh": "1 John",
	"1Joh": "1 John",
	"I Jn": "1 John",
	"I John": "1 John",
	"I Joh": "1 John",

	// 2 John
	"2 Jn": "2 John",
	"2 Jn.": "2 John",
	"2Jn": "2 John",
	"2 Joh": "2 John",
	"2Joh": "2 John",
	"II Jn": "2 John",
	"II John": "2 John",
	"II Joh": "2 John",

	// 3 John
	"3 Jn": "3 John",
	"3 Jn.": "3 John",
	"3Jn": "3 John",
	"3 Joh": "3 John",
	"3Joh": "3 John",
	"III Jn": "3 John",
	"III John": "3 John",
	"III Joh": "3 John",

	// Jude
	Jud: "Jude",
	"Jud.": "Jude",

	// Revelation
	Rev: "Revelation",
	"Rev.": "Revelation",
	Rv: "Revelation",
	Apoc: "Revelation",
};

// ---------------------------------------------------------------------------
// Regex construction
// ---------------------------------------------------------------------------

/**
 * Escapes a string for safe inclusion in a regex source.
 * Handles the period character which appears in abbreviations like "Gen.".
 */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the compiled book-name regex.
 *
 * Strategy:
 * 1. Collect all recognized tokens (canonical names + abbreviation keys).
 * 2. Sort by descending length so longer variants match first (prevents
 *    "1 Cor" matching inside "1 Corinthians").
 * 3. Wrap in a non-capturing alternation group.
 * 4. Follow with optional whitespace, chapter:verse[-verseEnd] pattern.
 *
 * The verse-end capture is optional (the "-\d+" suffix).
 * The trailing word boundary uses \b but is omitted for abbreviations that
 * end with a period since "." is not a word character.
 */
function buildBibleRegex(): RegExp {
	const allTokens: string[] = [
		...Object.keys(BOOKS_BY_TESTAMENT),
		...Object.keys(ABBREVIATION_MAP),
	];

	// Deduplicate (canonical names may also be in abbreviation map)
	const uniqueTokens = [...new Set(allTokens)];

	// Sort: longer strings first to ensure greedy alternation
	uniqueTokens.sort((a, b) => b.length - a.length);

	const bookGroup = uniqueTokens.map(escapeRegex).join("|");

	// Full pattern:
	//   (book name alternation) \s* (\d+) : (\d+) (?: - (\d+) )?
	//
	// We use a lookahead after the book name to confirm it's followed by
	// whitespace and digits (i.e., a chapter reference), not another word.
	// This prevents "Song" from matching "Songs" incorrectly.
	//
	// The (?!\w) negative lookahead prevents partial word matches for tokens
	// that do not end with a period.
	const pattern =
		`(?<![\\w])` + // no word character immediately before the book name
		`(${bookGroup})` + // group 1: book name or abbreviation
		`(?![\\w])` + // no word character immediately after (avoids "Genesis5" etc.)
		`\\.?` + // allow optional trailing period after book name itself
		`\\s*` + // optional whitespace between book name and chapter
		`(\\d{1,3})` + // group 2: chapter number
		`:` +
		`(\\d{1,3})` + // group 3: verse start
		`(?:-(\\d{1,3}))?`; // group 4 (optional): verse end

	return new RegExp(pattern, "g");
}

// Build once at module load time so repeated calls to parseBibleVerses are fast.
const BIBLE_REGEX = buildBibleRegex();

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/**
 * Resolves a matched book token to its canonical full name.
 * Checks the abbreviation map first, then assumes it is already canonical.
 */
function normalizeBookName(token: string): string {
	return ABBREVIATION_MAP[token] ?? token;
}

/**
 * Builds a canonical human-readable reference string.
 * Examples: "John 3:16", "Romans 8:28-30", "1 Corinthians 13:4-7"
 */
function buildReference(
	book: string,
	chapter: number,
	verseStart: number,
	verseEnd: number | null,
): string {
	const base = `${book} ${chapter}:${verseStart}`;
	return verseEnd !== null ? `${base}-${verseEnd}` : base;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type { BibleVerseRef };

/**
 * Extracts all Bible verse references from the given text.
 *
 * Each reference is returned as a BibleVerseRef with a normalized book name,
 * parsed chapter and verse numbers, and testament classification.
 *
 * The same verse can appear multiple times if it is cited multiple times in
 * the text; the caller is responsible for deduplication if needed.
 *
 * @param text - Raw article content (markdown or plain text).
 * @returns Array of extracted verse references in document order.
 */
export function parseBibleVerses(text: string): BibleVerseRef[] {
	// Reset lastIndex since the regex is compiled globally.
	BIBLE_REGEX.lastIndex = 0;

	const results: BibleVerseRef[] = [];
	let match: RegExpExecArray | null;

	while ((match = BIBLE_REGEX.exec(text)) !== null) {
		const [, rawBook, chapterStr, verseStartStr, verseEndStr] = match;

		const book = normalizeBookName(rawBook);
		const chapter = parseInt(chapterStr, 10);
		const verseStart = parseInt(verseStartStr, 10);
		const verseEnd =
			verseEndStr !== undefined ? parseInt(verseEndStr, 10) : null;

		// Guard: skip if normalization produced an unknown canonical name.
		const testament = BOOKS_BY_TESTAMENT[book];
		if (testament === undefined) {
			// This should never happen given our maps are consistent, but be safe.
			continue;
		}

		results.push({
			book,
			chapter,
			verseStart,
			verseEnd,
			reference: buildReference(book, chapter, verseStart, verseEnd),
			testament,
		});
	}

	return results;
}
