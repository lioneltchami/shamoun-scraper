/**
 * quran-parser.ts
 *
 * Extracts Quran verse references from free-form article text.
 *
 * The Sam Shamoun articles use two primary notation styles:
 *   - "S. 2:154"        (Surah notation, by far the most common)
 *   - "S. 17:13-15"     (range)
 *   - "Q. 3:55"         (alternative notation)
 *   - "Q. 2:154-155"    (range)
 *
 * Some citations are followed by a translator attribution like "Sher Ali" or
 * "Yusuf Ali" or "Pickthall". The parser ignores these trailing words.
 *
 * Additional edge cases handled:
 *   - "S.2:154"   (no space after period)
 *   - "Q2:154"    (no period or space)
 *   - Surah numbers 1-114 and ayah numbers up to 286 (Al-Baqarah is the longest)
 *
 * Design:
 *   A single compiled regex with an alternation on the prefix (S.|Q.) followed
 *   by optional whitespace, surah, colon, ayah-start, optional range suffix.
 *   Returned references are normalised to "S. N:N" form using the original
 *   prefix prefix letter from the match.
 */

import type { QuranVerseRef } from "../../types/verse";

// ---------------------------------------------------------------------------
// Regex construction
// ---------------------------------------------------------------------------

/**
 * Matches Quran verse citations in both "S." and "Q." forms.
 *
 * Groups:
 *   1 - prefix letter: "S" or "Q"
 *   2 - surah number
 *   3 - ayah start
 *   4 - ayah end (optional, from a range like "13-15")
 *
 * The regex deliberately does NOT capture translator names that may follow,
 * as they are not part of the verse reference.
 *
 * Lookahead/lookbehind:
 *   - Requires that the prefix is not preceded by a word character, to avoid
 *     matching "AS. 2:154" (unlikely in practice but worth guarding).
 *   - The prefix letter must be followed by an optional period, optional
 *     whitespace, then the surah number.
 */
const QURAN_REGEX =
  /(?<![A-Za-z])([SQ])\.?\s{0,2}(\d{1,3}):(\d{1,3})(?:-(\d{1,3}))?/g;

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/**
 * Builds a canonical Quran reference string.
 *
 * Always uses "S." prefix since that is the dominant convention in the articles.
 * This ensures consistent deduplication across references that use "Q." vs "S.".
 *
 * Examples:
 *   normaliseRef("S", 2, 154, null)   -> "S. 2:154"
 *   normaliseRef("Q", 3, 55,  null)   -> "S. 3:55"
 *   normaliseRef("S", 17, 13, 15)     -> "S. 17:13-15"
 */
function buildReference(
  surah: number,
  ayahStart: number,
  ayahEnd: number | null,
): string {
  const base = `S. ${surah}:${ayahStart}`;
  return ayahEnd !== null ? `${base}-${ayahEnd}` : base;
}

/**
 * Validates that the parsed surah and ayah numbers are within plausible bounds.
 * Surah: 1-114. Ayah: 1-286 (Al-Baqarah has 286 ayahs, the most of any surah).
 * We use a slightly generous upper bound (300) for robustness.
 */
function isValidRef(
  surah: number,
  ayahStart: number,
  ayahEnd: number | null,
): boolean {
  if (surah < 1 || surah > 114) return false;
  if (ayahStart < 1 || ayahStart > 300) return false;
  if (ayahEnd !== null && (ayahEnd < ayahStart || ayahEnd > 300)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type { QuranVerseRef };

/**
 * Extracts all Quran verse references from the given text.
 *
 * Both "S." and "Q." prefix styles are recognized. Returned references are
 * normalised to the "S. N:N" canonical form for consistent deduplication.
 *
 * Translator attributions that follow the verse number are silently ignored.
 *
 * @param text - Raw article content (markdown or plain text).
 * @returns Array of extracted Quran verse references in document order.
 */
export function parseQuranVerses(text: string): QuranVerseRef[] {
  QURAN_REGEX.lastIndex = 0;

  const results: QuranVerseRef[] = [];
  let match: RegExpExecArray | null;

  while ((match = QURAN_REGEX.exec(text)) !== null) {
    const [, , surahStr, ayahStartStr, ayahEndStr] = match;

    const surah = parseInt(surahStr, 10);
    const ayahStart = parseInt(ayahStartStr, 10);
    const ayahEnd = ayahEndStr !== undefined ? parseInt(ayahEndStr, 10) : null;

    if (!isValidRef(surah, ayahStart, ayahEnd)) {
      continue;
    }

    results.push({
      surah,
      ayahStart,
      ayahEnd,
      reference: buildReference(surah, ayahStart, ayahEnd),
    });
  }

  return results;
}
