/**
 * verse.ts
 *
 * Central type definitions for Bible and Quran verse references used throughout
 * the Sam Shamoun Apologetics Library. These types are shared between the
 * verse parsers, the extraction script, and the Next.js application layer.
 */

// ---------------------------------------------------------------------------
// Parser output types
// These are the objects returned by parseBibleVerses() and parseQuranVerses().
// ---------------------------------------------------------------------------

/**
 * A single Bible verse reference extracted from article text.
 * book is always the full canonical name (e.g. "John", "Psalms", "1 Corinthians").
 */
export interface BibleVerseRef {
  /** Canonical full book name, e.g. "John", "1 Corinthians", "Psalms". */
  book: string;
  chapter: number;
  verseStart: number;
  /** null for single-verse citations like "John 3:16". */
  verseEnd: number | null;
  /** Human-readable reference, e.g. "John 3:16" or "Romans 8:28-30". */
  reference: string;
  testament: "OT" | "NT";
}

/**
 * A single Quran verse reference extracted from article text.
 * Handles both "S. 2:154" and "Q. 3:55" notation styles.
 */
export interface QuranVerseRef {
  surah: number;
  ayahStart: number;
  /** null for single-ayah citations like "S. 2:154". */
  ayahEnd: number | null;
  /** Canonical reference string, e.g. "S. 2:154" or "S. 17:13-15". */
  reference: string;
}

// ---------------------------------------------------------------------------
// Database row types
// These mirror the columns in the bible_verses and quran_verses tables.
// ---------------------------------------------------------------------------

/**
 * A row in the bible_verses table.
 */
export interface BibleVerse {
  id: string;
  book: string;
  chapter: number;
  verse_start: number;
  verse_end: number | null;
  reference: string;
  testament: "OT" | "NT";
}

/**
 * A row in the quran_verses table.
 */
export interface QuranVerse {
  id: string;
  surah: number;
  ayah_start: number;
  ayah_end: number | null;
  reference: string;
  surah_name: string | null;
}

// ---------------------------------------------------------------------------
// Junction table row types
// ---------------------------------------------------------------------------

/**
 * A row in the article_bible_verses junction table.
 */
export interface ArticleBibleVerse {
  article_id: string;
  verse_id: string;
  occurrence_count: number;
}

/**
 * A row in the article_quran_verses junction table.
 */
export interface ArticleQuranVerse {
  article_id: string;
  verse_id: string;
  occurrence_count: number;
}
