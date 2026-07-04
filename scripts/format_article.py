#!/usr/bin/env python3
"""
Definitive Article Formatter for Shamoun Library.
=================================================

The single source of truth for converting HTML or raw markdown into clean,
standardized Shamoun Library articles. Incorporates all html2text settings
from the Shamoun scraper, all cleaning rules from both Shamoun and Shimba
pipelines, and fixes every known artifact issue.

Usage:
    from format_article import format_article
    markdown = format_article(title, html_content, source_url, category_id, category_name)

Or as CLI:
    python scripts/format_article.py --title "..." --html "<p>...</p>" --url "..." \
        --category-id 21 --category-name "Max Shimba"

Or test mode:
    python scripts/format_article.py --test
"""

import re
from difflib import SequenceMatcher
from urllib.parse import urlparse

import html2text


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1: HTML2TEXT CONFIGURATION
# All settings from scrape_shamoun.py + additional quality improvements
# ═══════════════════════════════════════════════════════════════════════════════

_h2t = html2text.HTML2Text()

# --- Core settings (from scrape_shamoun.py) ---
_h2t.ignore_links = False
_h2t.ignore_images = True
_h2t.body_width = 0              # No line wrapping
_h2t.unicode_snob = True         # Use unicode chars instead of HTML entities
_h2t.skip_internal_links = True  # Remove useless #anchor links
_h2t.inline_links = True         # [text](url) not [text][ref]
_h2t.protect_links = True        # Don't wrap URLs
_h2t.ignore_emphasis = False     # Keep bold/italic

# --- Additional quality settings ---
_h2t.decode_errors = "replace"       # Don't crash on encoding issues
_h2t.wrap_links = False              # Never break URLs
_h2t.wrap_list_items = False         # Don't break list items mid-line
_h2t.use_automatic_links = False     # Always [text](url), never <url>
_h2t.pad_tables = True               # Readable table alignment
_h2t.open_quote = "\u201c"           # Curly open quote "
_h2t.close_quote = "\u201d"          # Curly close quote "
_h2t.emphasis_mark = "_"             # Consistent: _italic_
_h2t.strong_mark = "**"             # Consistent: **bold**


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2: PUBLIC API
# ═══════════════════════════════════════════════════════════════════════════════

def format_article(
    title: str,
    html_content: str,
    source_url: str,
    category_id: int,
    category_name: str,
    source_name: str = "",
) -> str:
    """
    Convert raw HTML content into a clean, standardized markdown article.

    Args:
        title: Article title (plain text)
        html_content: Raw HTML of the article body
        source_url: URL where the article was scraped from
        category_id: Numeric category ID (e.g., 21)
        category_name: Human-readable category name
        source_name: Display name for the source site (auto-detected if empty)

    Returns:
        Complete markdown string ready to save as .md file
    """
    markdown = _h2t.handle(html_content)
    return _assemble_article(title, markdown, source_url, category_id, category_name, source_name)


def format_article_from_markdown(
    title: str,
    markdown_content: str,
    source_url: str,
    category_id: int,
    category_name: str,
    source_name: str = "",
) -> str:
    """
    Same as format_article but input is already markdown.
    Applies all cleaning but skips html2text conversion.
    """
    return _assemble_article(title, markdown_content, source_url, category_id, category_name, source_name)



# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3: ASSEMBLY & METADATA
# ═══════════════════════════════════════════════════════════════════════════════

def _assemble_article(
    title: str,
    markdown: str,
    source_url: str,
    category_id: int,
    category_name: str,
    source_name: str,
) -> str:
    """Assemble final article: extract metadata, clean, build header."""
    # Idempotency check — don't re-format already-formatted articles
    if _is_already_formatted(markdown):
        return markdown

    # Detect and remove content duplication (entire article repeated)
    markdown = _detect_duplication(markdown)

    # Extract metadata before cleaning removes it
    markdown, metadata = _extract_metadata(markdown)

    # Apply all cleaning passes
    markdown = _clean_markdown(markdown, title)

    # Fix title case
    title = _fix_title_case(title.strip())
    title = _escape_title(title)

    # Build source name
    if not source_name:
        source_name = _extract_site_name(source_url)

    # Build header
    header = f"# {title}\n\n"
    header += f"**Source:** [{source_name}]({source_url})\n\n"
    header += f"**Category:** {category_id:02d} {category_name}\n\n"

    # Include preserved metadata
    if metadata.get('author'):
        header += f"**Author:** {metadata['author']}\n\n"
    if metadata.get('date') or metadata.get('published'):
        header += f"**Date:** {metadata.get('date') or metadata.get('published')}\n\n"

    header += "---\n\n"

    return header + markdown.strip() + "\n"


def _extract_metadata(text: str) -> tuple:
    """Extract metadata fields before cleaning removes them. Returns (cleaned_text, metadata_dict)."""
    metadata = {}
    for field in ['Published', 'Date', 'Author', 'Keyword']:
        match = re.search(rf'^\*{field}:\s*(.+?)\*\s*$', text, re.MULTILINE)
        if match:
            metadata[field.lower()] = match.group(1).strip()
    # Remove metadata lines from body
    text = re.sub(r'^\*(Published|Keyword|Date|Author):.*?\*\s*$', '', text, flags=re.MULTILINE)
    return text, metadata


def _is_already_formatted(text: str) -> bool:
    """Detect if text already has our header format."""
    lines = text.split('\n', 6)
    return (len(lines) >= 5 and
            lines[0].startswith('# ') and
            '**Source:**' in '\n'.join(lines[:5]) and
            '**Category:**' in '\n'.join(lines[:6]))


def _detect_duplication(text: str) -> str:
    """Detect and remove full content duplication (article appears twice)."""
    if len(text) < 500:
        return text
    half = len(text) // 2
    first_half = text[:half]
    second_half = text[half:]
    if SequenceMatcher(None, first_half[:500], second_half[:500]).ratio() > 0.8:
        return first_half.rstrip()
    return text



# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4: MASTER CLEANING PIPELINE
# ═══════════════════════════════════════════════════════════════════════════════

def _clean_markdown(text: str, title: str) -> str:
    """Apply all cleaning rules in correct order to produce Shamoun-standard markdown."""

    # --- Pass 1: Unicode & encoding normalization ---
    text = _normalize_unicode(text)

    # --- Pass 2: Remove boilerplate (nav, share buttons, comments, copyright) ---
    text = _remove_boilerplate(text)

    # --- Pass 3: Remove duplicate title from body ---
    text = _remove_duplicate_title(text, title)

    # --- Pass 4: Heading normalization ---
    text = _normalize_headings(text)

    # --- Pass 5: Emphasis/bold normalization ---
    text = _fix_emphasis(text)

    # --- Pass 6: Link cleanup ---
    text = _clean_links(text)

    # --- Pass 7: Table cleanup ---
    text = _clean_tables(text)

    # --- Pass 8: Horizontal rule normalization ---
    text = _normalize_horizontal_rules(text)

    # --- Pass 9: Whitespace normalization ---
    text = _normalize_whitespace(text)

    # --- Pass 10: Remove trailing separators and empty sections ---
    text = _remove_trailing_artifacts(text)

    return text



# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5: CLEANING FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════════

# --- 5A: Unicode & Encoding ---

def _normalize_unicode(text: str) -> str:
    """Normalize encoding artifacts and special whitespace characters."""
    text = text.replace('\u00a0', ' ')   # Non-breaking space → regular space
    text = text.replace('\u200b', '')    # Zero-width space → remove
    text = text.replace('\ufeff', '')    # BOM → remove
    text = text.replace('\u200e', '')    # Left-to-right mark → remove
    text = text.replace('\u200f', '')    # Right-to-left mark → remove
    text = text.replace('\u2028', '\n')  # Line separator → newline
    text = text.replace('\u2029', '\n')  # Paragraph separator → newline
    # Fix common mojibake patterns
    text = text.replace('â€™', '\u2019')  # Right single quote
    text = text.replace('â€œ', '\u201c')  # Left double quote
    text = text.replace('â€\x9d', '\u201d')  # Right double quote
    text = text.replace('â€"', '\u2014')  # Em dash
    text = text.replace('â€"', '\u2013')  # En dash
    return text


# --- 5B: Boilerplate Removal ---

def _remove_boilerplate(text: str) -> str:
    """Remove navigation, share buttons, comment sections, copyright, and blog cruft."""

    # Copyright lines (anchored to line boundaries)
    text = re.sub(r'^.*Copyright\s*©?\s*(Max Shimba|Shimba|Sam Shamoun|Answering Islam).*$',
                  '', text, flags=re.MULTILINE | re.IGNORECASE)

    # "God bless you all" sign-off boilerplate
    text = re.sub(r'^God bless you all\.?\s*$', '', text, flags=re.MULTILINE)

    # Navigation boilerplate: "Home | Back | Top" style links
    text = re.sub(r'^\s*\[?\s*(Home|Back|Top|Next|Previous|Index)\s*\]?\s*(\|\s*\[?\s*(Home|Back|Top|Next|Previous|Index)\s*\]?\s*)*$',
                  '', text, flags=re.MULTILINE | re.IGNORECASE)

    # Share buttons: "Share this:", "Tweet", "Facebook", etc.
    text = re.sub(r'^\s*(Share\s*(this|on)?:?|Tweet|Facebook|LinkedIn|Pinterest|WhatsApp|Email\s*this|Print)\s*$',
                  '', text, flags=re.MULTILINE | re.IGNORECASE)
    # Share button clusters (multiple on one line)
    text = re.sub(r'^\s*(Share|Tweet|Like|Pin)\s+\d*\s*$', '', text, flags=re.MULTILINE)

    # Comment section markers
    text = re.sub(r'^\s*#{1,4}\s*(Comments?|Leave a (Reply|Comment)|Discussion)\s*$',
                  '', text, flags=re.MULTILINE | re.IGNORECASE)
    text = re.sub(r'^\s*(No comments?|Comments are closed|Post a comment)\.?\s*$',
                  '', text, flags=re.MULTILINE | re.IGNORECASE)

    # "Posted in / Tagged / Filed under" lines
    text = re.sub(r'^\s*(Posted in|Tagged|Filed under|Categories?:).*$',
                  '', text, flags=re.MULTILINE | re.IGNORECASE)

    # Blogger image URL artifacts (empty links to googleusercontent)
    text = re.sub(r'\[\]\(<https?://blogger\.googleusercontent\.com[^>]*>\)', '', text)
    text = re.sub(r'!\[\]\(https?://blogger\.googleusercontent\.com[^\)]*\)', '', text)

    # Empty image links at end of document
    text = re.sub(r'\n*\[\]\([^)]*\)\s*$', '', text)

    # "Read more" / "Continue reading" links
    text = re.sub(r'^\s*\[?(Read more|Continue reading|Click here)[^\]]*\]?\s*(\([^)]*\))?\s*$',
                  '', text, flags=re.MULTILINE | re.IGNORECASE)

    return text



# --- 5C: Title Deduplication ---

def _remove_duplicate_title(text: str, title: str) -> str:
    """Remove body title that duplicates the H1 header we'll add."""
    if not title or len(title.strip()) < 5:
        return text

    lines = text.split('\n')
    clean_title = title.strip().lower()
    new_lines = []
    title_removed = False

    for i, line in enumerate(lines):
        if i < 10 and not title_removed:
            stripped = line.strip().lstrip('#').strip().strip('*').strip()
            if stripped and len(stripped) > 5:
                stripped_lower = stripped.lower()
                # Match if body line starts with title or vice versa (fixed logic)
                if (stripped_lower == clean_title or
                    stripped_lower.startswith(clean_title[:30]) or
                    clean_title.startswith(stripped_lower[:30])):
                    title_removed = True
                    continue
        new_lines.append(line)

    return '\n'.join(new_lines)


# --- 5D: Heading Normalization ---

def _normalize_headings(text: str) -> str:
    """Fix heading issues: demote body H1s, remove bold inside headings, remove empty headings."""
    lines = text.split('\n')
    result = []

    for line in lines:
        # Remove empty headings (just # with nothing or just bold markers)
        if re.match(r'^#{1,6}\s*\*{0,4}\s*$', line):
            continue

        # Demote body H1s to H2 (we use H1 for the article title)
        if re.match(r'^# [^#]', line):
            line = '#' + line

        # Remove redundant bold inside headings: ## **Title** → ## Title
        line = re.sub(r'^(#{1,6})\s*\*\*(.+?)\*\*\s*$', r'\1 \2', line)

        result.append(line)

    return '\n'.join(result)


# --- 5E: Emphasis/Bold Normalization ---

def _fix_emphasis(text: str) -> str:
    """Normalize broken nested bold/italic patterns and orphan markers."""

    # Fix __**text**__ → **text** (redundant double-bold)
    text = re.sub(r'__\*\*([^*\n]+?)\*\*__', r'**\1**', text)
    text = re.sub(r'\*\*__([^_\n]+?)__\*\*', r'**\1**', text)

    # Fix nested _**text**_ → ***text*** (proper bold-italic)
    text = re.sub(r'_\*\*([^*\n]+?)\*\*_', r'***\1***', text)
    text = re.sub(r'\*\*_([^_\n]+?)_\*\*', r'***\1***', text)

    # Normalize __text__ to **text** for consistency
    text = re.sub(r'(?<!\w)__([^_\n]+?)__(?!\w)', r'**\1**', text)

    # Fix ****text**** (double-bold collapsed) → **text**
    text = re.sub(r'\*{4}([^*\n]+?)\*{4}', r'**\1**', text)

    # Remove empty bold/italic markers: ****, ***, __, etc.
    text = re.sub(r'(?<!\*)\*{4,}(?!\*)', '', text)  # **** (empty bold pairs)
    text = re.sub(r'(?<!\*)(\*{2,3})\s*\1(?!\*)', '', text)  # ** ** or *** ***

    # Orphan ** at start/end of line with no matching pair
    text = re.sub(r'^\*\*\s*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\s*\*\*$', '', text, flags=re.MULTILINE)

    # Orphan __ at start/end of line with no matching pair
    text = re.sub(r'^__\s*$', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\s*__$', '', text, flags=re.MULTILINE)

    return text



# --- 5F: Link Cleanup ---

def _clean_links(text: str) -> str:
    """Fix link artifacts: tooltips, angle brackets, empty links, broken markdown links."""

    # Remove link tooltip artifacts: [text](<url> "tooltip") → [text](url)
    text = re.sub(r'\[([^\]]*)\]\(<([^>]+)>\s*"[^"]*"\)', r'[\1](\2)', text)
    text = re.sub(r'\[([^\]]*)\]\(([^\s)]+)\s+"[^"]*"\)', r'[\1](\2)', text)

    # Normalize [text](<url>) → [text](url) when URL has no special chars
    text = re.sub(r'\[([^\]]*)\]\(<([^>\s]+)>\)', r'[\1](\2)', text)

    # Remove completely empty links: []() or [](url) with no text
    text = re.sub(r'\[\]\([^)]*\)', '', text)

    # Remove broken markdown links with no URL: [text]() or [text](  )
    text = re.sub(r'\[([^\]]+)\]\(\s*\)', r'\1', text)

    # Fix URLs with parentheses — wrap in angle brackets
    def _fix_paren_url(m):
        link_text, url = m.group(1), m.group(2)
        if '(' in url or ')' in url:
            return f'[{link_text}](<{url}>)'
        return m.group(0)
    text = re.sub(r'\[([^\]]*)\]\(([^)]*\([^)]*\)[^)]*)\)', _fix_paren_url, text)

    return text


# --- 5G: Table Cleanup ---

def _clean_tables(text: str) -> str:
    """Clean up markdown tables: fix alignment, remove empty rows."""

    # Remove completely empty table rows (just pipes and spaces)
    text = re.sub(r'^\|[\s|]*\|\s*$', '', text, flags=re.MULTILINE)

    # Normalize table separator rows (ensure proper format)
    text = re.sub(r'^\|[\s:-]+\|\s*$',
                  lambda m: re.sub(r'\s+', ' ', m.group(0)),
                  text, flags=re.MULTILINE)

    # Remove tables that are just a header with no data rows
    # (header + separator + nothing)
    text = re.sub(r'(\|[^\n]+\|\n\|[-:\s|]+\|\n)(?=\n|\Z)', '', text)

    return text



# --- 5H: Horizontal Rule Normalization ---

def _normalize_horizontal_rules(text: str) -> str:
    """Normalize all HR variants to standard ---"""
    # * * * (with optional extra asterisks/spaces)
    text = re.sub(r'^\*\s*\*\s*\*[\s*]*$', '---', text, flags=re.MULTILINE)
    # *** (no spaces)
    text = re.sub(r'^\*{3,}\s*$', '---', text, flags=re.MULTILINE)
    # - - - (with optional extra dashes/spaces)
    text = re.sub(r'^-\s*-\s*-[\s-]*$', '---', text, flags=re.MULTILINE)
    # _ _ _ (with optional extra underscores/spaces)
    text = re.sub(r'^_\s*_\s*_[\s_]*$', '---', text, flags=re.MULTILINE)
    # ___ (no spaces)
    text = re.sub(r'^_{3,}\s*$', '---', text, flags=re.MULTILINE)
    # Collapse multiple consecutive horizontal rules
    text = re.sub(r'(---\n){2,}', '---\n', text)
    return text


# --- 5I: Whitespace Normalization ---

def _normalize_whitespace(text: str) -> str:
    """Fix all whitespace issues."""
    # Remove trailing whitespace on every line (including trailing double-spaces that create <br>)
    text = re.sub(r'[ \t]+$', '', text, flags=re.MULTILINE)

    # Remove double-space indentation artifacts (from &nbsp; conversion)
    text = re.sub(r'^  (?! )', '', text, flags=re.MULTILINE)

    # Collapse excessive blank lines (max 2 consecutive newlines = 1 blank line)
    text = re.sub(r'\n{4,}', '\n\n\n', text)

    # Remove leading blank lines
    text = text.lstrip('\n')

    return text


# --- 5J: Trailing Artifacts ---

def _remove_trailing_artifacts(text: str) -> str:
    """Remove trailing separators, empty sections, and dangling content."""
    # Remove trailing --- at end of document
    text = re.sub(r'\n---\s*$', '', text)

    # Remove trailing empty headings
    text = re.sub(r'\n#{1,6}\s*\n*$', '', text)

    # Remove trailing blank lines
    text = text.rstrip('\n')

    return text



# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 6: UTILITY FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════════

def _fix_title_case(title: str) -> str:
    """Convert ALL CAPS titles to Title Case. Leave mixed-case alone."""
    if title == title.upper() and len(title) > 10:
        return title.title()
    return title


def _escape_title(title: str) -> str:
    """Escape chars that break H1 rendering in markdown."""
    title = title.replace('[', '\\[').replace(']', '\\]')
    return title


def _extract_site_name(url: str) -> str:
    """Extract a human-readable display name from a URL."""
    if 'answeringislam' in url:
        return 'Answering Islam'
    if 'maxshimba' in url:
        return 'Max Shimba Ministries'
    if 'youtube.com' in url or 'youtu.be' in url:
        return 'YouTube'
    if 'blogger.com' in url or 'blogspot.com' in url:
        return 'Blogger'
    domain = urlparse(url).netloc
    return domain.replace('www.', '').split('.')[0].title()


def slugify(title: str, max_len: int = 80) -> str:
    """Generate a URL-safe slug from a title."""
    slug = title.lower().strip()
    slug = re.sub(r'[^\w\s-]', '', slug)
    slug = re.sub(r'[\s_]+', '_', slug)
    return slug[:max_len].strip('_')



# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 7: QUALITY VALIDATION & TESTING
# ═══════════════════════════════════════════════════════════════════════════════

def validate_output(text: str) -> dict:
    """
    Validate formatted output quality. Returns dict with pass/fail and issues found.

    Checks:
        - Has proper H1 title
        - Has Source and Category metadata
        - No orphan bold/italic markers
        - No empty links
        - No duplicate titles
        - No excessive blank lines
        - No encoding artifacts
        - No boilerplate remnants
    """
    issues = []
    lines = text.split('\n')

    # Must start with H1
    if not lines[0].startswith('# '):
        issues.append("MISSING_H1: Article doesn't start with H1 title")

    # Must have Source and Category
    header_block = '\n'.join(lines[:8])
    if '**Source:**' not in header_block:
        issues.append("MISSING_SOURCE: No **Source:** in header")
    if '**Category:**' not in header_block:
        issues.append("MISSING_CATEGORY: No **Category:** in header")

    # Check for orphan emphasis markers
    orphan_bold = re.findall(r'^\*\*\s*$|^\s*\*\*$', text, re.MULTILINE)
    if orphan_bold:
        issues.append(f"ORPHAN_BOLD: {len(orphan_bold)} orphan ** markers")

    # Check for empty links
    empty_links = re.findall(r'\[\]\([^)]*\)', text)
    if empty_links:
        issues.append(f"EMPTY_LINKS: {len(empty_links)} empty []() links")

    # Check for excessive blank lines (4+ consecutive newlines)
    excessive_blanks = re.findall(r'\n{4,}', text)
    if excessive_blanks:
        issues.append(f"EXCESSIVE_BLANKS: {len(excessive_blanks)} sections with 4+ blank lines")

    # Check for encoding artifacts
    encoding_artifacts = re.findall(r'â€[™œ"\x9d"—]', text)
    if encoding_artifacts:
        issues.append(f"ENCODING_ARTIFACTS: {len(encoding_artifacts)} mojibake patterns")

    # Check for non-breaking spaces
    nbsp_count = text.count('\u00a0')
    if nbsp_count > 0:
        issues.append(f"NBSP: {nbsp_count} non-breaking spaces remain")

    # Check for empty bold markers
    empty_bold = re.findall(r'\*{4,}', text)
    if empty_bold:
        issues.append(f"EMPTY_BOLD: {len(empty_bold)} empty **** markers")

    # Check for tooltip artifacts in links
    tooltip_links = re.findall(r'\[[^\]]*\]\([^)]*"[^"]*"\)', text)
    if tooltip_links:
        issues.append(f"TOOLTIP_LINKS: {len(tooltip_links)} links with tooltip text")

    # Check for navigation boilerplate
    nav_patterns = re.findall(r'^\s*\[?(Home|Back|Top)\s*\|', text, re.MULTILINE | re.IGNORECASE)
    if nav_patterns:
        issues.append(f"NAV_BOILERPLATE: {len(nav_patterns)} navigation lines remain")

    return {
        'valid': len(issues) == 0,
        'issues': issues,
        'score': max(0, 100 - len(issues) * 10),
        'line_count': len(lines),
        'word_count': len(text.split()),
    }


def run_tests():
    """Run validation tests on sample content to verify formatter quality."""
    print("=" * 70)
    print("FORMAT_ARTICLE.PY — QUALITY VALIDATION TESTS")
    print("=" * 70)

    tests_passed = 0
    tests_total = 0

    # Test 1: Basic HTML formatting
    tests_total += 1
    html = "<h2>Introduction</h2><p>This is a <b>test</b> article about <i>important</i> topics.</p>"
    result = format_article("Test Article", html, "https://answeringislam.info/test", 1, "Test Category")
    v = validate_output(result)
    if v['valid']:
        tests_passed += 1
        print(f"\n✅ Test 1 PASS: Basic HTML formatting (score: {v['score']})")
    else:
        print(f"\n❌ Test 1 FAIL: Basic HTML formatting")
        for issue in v['issues']:
            print(f"   - {issue}")

    # Test 2: Emphasis normalization
    tests_total += 1
    md = "_**bold italic text**_ and __double underscore__ and ****empty****"
    result = format_article_from_markdown("Emphasis Test", md, "https://example.com", 4, "Test")
    if '****' not in result and '__' not in result and '***bold italic text***' in result:
        tests_passed += 1
        print(f"✅ Test 2 PASS: Emphasis normalization")
    else:
        print(f"❌ Test 2 FAIL: Emphasis normalization")
        print(f"   Got: {result[result.find('---')+4:result.find('---')+100]}")

    # Test 3: Title deduplication
    tests_total += 1
    md = "# My Great Article\n\nSome content here about things."
    result = format_article_from_markdown("My Great Article", md, "https://example.com", 1, "Test")
    body = result[result.find('---\n\n') + 5:]
    if body.count('My Great Article') == 0:  # Should not appear in body
        tests_passed += 1
        print(f"✅ Test 3 PASS: Title deduplication")
    else:
        print(f"❌ Test 3 FAIL: Title deduplication — title still in body")

    # Test 4: Boilerplate removal
    tests_total += 1
    md = "Article content.\n\nShare this:\nTweet\nFacebook\n\nCopyright © Max Shimba 2024\n\nGod bless you all"
    result = format_article_from_markdown("Boilerplate Test", md, "https://maxshimba.com", 21, "Shimba")
    if 'Share this' not in result and 'Copyright' not in result and 'God bless' not in result:
        tests_passed += 1
        print(f"✅ Test 4 PASS: Boilerplate removal")
    else:
        print(f"❌ Test 4 FAIL: Boilerplate remains in output")

    # Test 5: Link cleanup
    tests_total += 1
    md = '[text](<http://example.com> "Opens in new window") and [](http://empty.com) and [broken]()'
    result = format_article_from_markdown("Link Test", md, "https://example.com", 1, "Test")
    if '"Opens' not in result and '[](http://empty.com)' not in result and '[broken]()' not in result:
        tests_passed += 1
        print(f"✅ Test 5 PASS: Link cleanup")
    else:
        print(f"❌ Test 5 FAIL: Link artifacts remain")

    # Test 6: ALL CAPS title fix
    tests_total += 1
    result = format_article_from_markdown("THIS IS AN ALL CAPS TITLE", "Content.", "https://x.com", 1, "T")
    if result.startswith('# This Is An All Caps Title'):
        tests_passed += 1
        print(f"✅ Test 6 PASS: ALL CAPS title converted to Title Case")
    else:
        print(f"❌ Test 6 FAIL: ALL CAPS title not fixed")
        print(f"   Got: {result.split(chr(10))[0]}")

    # Test 7: Horizontal rule normalization
    tests_total += 1
    md = "Before\n\n* * *\n\nMiddle\n\n_ _ _\n\nAfter"
    result = format_article_from_markdown("HR Test", md, "https://x.com", 1, "Test")
    body = result[result.find('---\n\n') + 5:]
    if '* * *' not in body and '_ _ _' not in body and '---' in body:
        tests_passed += 1
        print(f"✅ Test 7 PASS: Horizontal rule normalization")
    else:
        print(f"❌ Test 7 FAIL: HR variants not normalized")

    # Test 8: Idempotency
    tests_total += 1
    first_pass = format_article_from_markdown("Idem Test", "Content here.", "https://x.com", 1, "Test")
    second_pass = format_article_from_markdown("Idem Test", first_pass, "https://x.com", 1, "Test")
    if first_pass == second_pass:
        tests_passed += 1
        print(f"✅ Test 8 PASS: Idempotency (double-format produces same output)")
    else:
        print(f"❌ Test 8 FAIL: Output changes on second format pass")

    # Test 9: Unicode normalization
    tests_total += 1
    md = "Text\u00a0with\u00a0nbsp and\u200bzero-width and\ufeffBOM"
    result = format_article_from_markdown("Unicode Test", md, "https://x.com", 1, "Test")
    if '\u00a0' not in result and '\u200b' not in result and '\ufeff' not in result:
        tests_passed += 1
        print(f"✅ Test 9 PASS: Unicode normalization")
    else:
        print(f"❌ Test 9 FAIL: Unicode artifacts remain")

    # Test 10: Content duplication detection
    tests_total += 1
    content = "This is a substantial paragraph of content that goes on for a while to test duplication.\n\n"
    md = content * 3 + "---\n\n" + content * 3
    result = format_article_from_markdown("Dup Test", md, "https://x.com", 1, "Test")
    body = result[result.find('---\n\n') + 5:]
    # Should be roughly half the size since duplication was removed
    if len(body) < len(md) * 0.7:
        tests_passed += 1
        print(f"✅ Test 10 PASS: Content duplication detection")
    else:
        print(f"❌ Test 10 FAIL: Duplicated content not removed (body={len(body)}, input={len(md)})")

    # Summary
    print(f"\n{'=' * 70}")
    print(f"RESULTS: {tests_passed}/{tests_total} tests passed")
    print(f"{'=' * 70}")

    return tests_passed == tests_total



# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 8: CLI INTERFACE
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="Format an article to Shamoun Library standard")
    parser.add_argument("--title", help="Article title")
    parser.add_argument("--html", help="HTML content (or pass via stdin)")
    parser.add_argument("--markdown", help="Markdown content (skip html2text conversion)")
    parser.add_argument("--url", help="Source URL")
    parser.add_argument("--category-id", type=int, help="Category ID")
    parser.add_argument("--category-name", help="Category name")
    parser.add_argument("--source-name", default="", help="Display name for source")
    parser.add_argument("--output", help="Output file path (default: stdout)")
    parser.add_argument("--test", action="store_true", help="Run validation tests")
    parser.add_argument("--validate", help="Validate an existing formatted file")

    args = parser.parse_args()

    if args.test:
        success = run_tests()
        sys.exit(0 if success else 1)

    if args.validate:
        with open(args.validate, 'r') as f:
            content = f.read()
        v = validate_output(content)
        print(f"File: {args.validate}")
        print(f"Valid: {v['valid']} | Score: {v['score']}/100 | Lines: {v['line_count']} | Words: {v['word_count']}")
        if v['issues']:
            print("Issues:")
            for issue in v['issues']:
                print(f"  - {issue}")
        sys.exit(0 if v['valid'] else 1)

    # Normal formatting mode
    if not args.title or not args.url or args.category_id is None or not args.category_name:
        parser.error("--title, --url, --category-id, and --category-name are required for formatting")

    if args.markdown:
        content = args.markdown
        result = format_article_from_markdown(
            title=args.title, markdown_content=content,
            source_url=args.url, category_id=args.category_id,
            category_name=args.category_name, source_name=args.source_name,
        )
    else:
        content = args.html if args.html else sys.stdin.read()
        result = format_article(
            title=args.title, html_content=content,
            source_url=args.url, category_id=args.category_id,
            category_name=args.category_name, source_name=args.source_name,
        )

    if args.output:
        with open(args.output, 'w') as f:
            f.write(result)
        print(f"Written to {args.output}", file=sys.stderr)
    else:
        print(result)
