#!/usr/bin/env python3
"""
Comprehensive scraper for Sam Shamoun's articles from answeringislam.info
Downloads all articles from both index pages, organized by category.
"""

import os
import re
import sys
import time
import json
import hashlib
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin, urlparse, unquote
import html2text

# ─────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ARTICLES_DIR = os.path.join(BASE_DIR, "articles")
METADATA_FILE = os.path.join(BASE_DIR, "articles_metadata.json")
FAILED_LOG = os.path.join(BASE_DIR, "failed_downloads.log")

OLD_INDEX_URL = "https://answeringislam.info/Shamoun/index.htm"
NEW_INDEX_URL = "https://answeringislam.info/Authors/Shamoun/index.html"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}

DELAY_BETWEEN_REQUESTS = 1.5  # seconds, be polite
MAX_RETRIES = 3
TIMEOUT = 30

# ─────────────────────────────────────────────
# Category definitions - OLD INDEX
# ─────────────────────────────────────────────
# These map section headings from the old index page to folder names
OLD_INDEX_CATEGORIES = [
    ("A Series of Answers to Common Questions and Claims", "01_common_questions_and_claims"),
    ("General Issues", "02_general_issues"),
    ("Theological Issues", "03_theological_issues"),
    ("Christological Issues", "04_christological_issues"),
    ("Quranic Issues", "05_quranic_issues"),
    ("Analysis of Muhammad", "06_analysis_of_muhammad"),
    ("Analysis of the Hadith Literature", "07_hadith_literature"),
    ("Polemical Issues", "08_polemical_issues"),
    ("Debate Challenges", "09_debate_challenges"),
    ("Debate Material", "10_debate_material"),
    ("Articles by Sam Shamoun on other websites", "11_articles_on_other_websites"),
]

# ─────────────────────────────────────────────
# Category definitions - NEW INDEX
# ─────────────────────────────────────────────
NEW_INDEX_CATEGORIES = [
    ("Answers to Common Questions and Claims by Muslims", "12_new_common_questions"),
    ("Short Summary Articles", "13_short_summary_articles"),
    ("Turning the Tables", "14_turning_the_tables"),
    ("Christological Issues", "15_new_christological_issues"),
    ("Theological Issues", "16_new_theological_issues"),
    ("Biblical Issues", "17_biblical_issues"),
    ("Quranic Issues", "18_new_quranic_issues"),
    ("Analysis of Muhammad", "19_new_analysis_of_muhammad"),
    ("Responses to Muslim Authors", "20_responses_to_muslim_authors"),
]


def sanitize_filename(name, max_length=80):
    """Create a safe filename from article title."""
    # Remove/replace problematic characters
    name = re.sub(r'[<>:"/\\|?*]', '', name)
    name = re.sub(r'[\s]+', '_', name)
    name = re.sub(r'[^\w\-_.]', '', name)
    name = name.strip('_. ')
    if len(name) > max_length:
        name = name[:max_length].rstrip('_')
    return name.lower() if name else "untitled"


def make_request(url, retries=MAX_RETRIES):
    """Make an HTTP request with retries and error handling."""
    for attempt in range(retries):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
            resp.raise_for_status()
            return resp
        except requests.exceptions.HTTPError as e:
            if resp.status_code == 404:
                print(f"  [404] Not found: {url}")
                return None
            if attempt < retries - 1:
                wait = (attempt + 1) * 3
                print(f"  [HTTP {resp.status_code}] Retry {attempt+1}/{retries} in {wait}s: {url}")
                time.sleep(wait)
            else:
                print(f"  [FAIL] HTTP {resp.status_code} after {retries} attempts: {url}")
                return None
        except requests.exceptions.ConnectionError as e:
            if attempt < retries - 1:
                wait = (attempt + 1) * 5
                print(f"  [CONN ERROR] Retry {attempt+1}/{retries} in {wait}s: {url}")
                time.sleep(wait)
            else:
                print(f"  [FAIL] Connection error after {retries} attempts: {url}")
                return None
        except requests.exceptions.Timeout:
            if attempt < retries - 1:
                wait = (attempt + 1) * 3
                print(f"  [TIMEOUT] Retry {attempt+1}/{retries} in {wait}s: {url}")
                time.sleep(wait)
            else:
                print(f"  [FAIL] Timeout after {retries} attempts: {url}")
                return None
        except Exception as e:
            print(f"  [ERROR] {type(e).__name__}: {e} - {url}")
            return None
    return None


def extract_article_content(html_content, url):
    """Extract the main article content from HTML and convert to markdown."""
    soup = BeautifulSoup(html_content, 'html.parser')

    # Try to get the title
    title = ""
    title_tag = soup.find('title')
    if title_tag:
        title = title_tag.get_text(strip=True)

    # Also check for h1, h2, h3 as title candidates
    for tag in ['h1', 'h2', 'h3']:
        heading = soup.find(tag)
        if heading and not title:
            title = heading.get_text(strip=True)
            break

    # Extract main content - try various common content containers
    content_area = None
    for selector in ['article', 'main', '.content', '#content', '.article',
                      'td[width]', 'body']:
        content_area = soup.select_one(selector)
        if content_area:
            break

    if not content_area:
        content_area = soup.find('body') or soup

    # Convert to markdown
    converter = html2text.HTML2Text()
    converter.body_width = 0  # Don't wrap lines
    converter.ignore_links = False
    converter.ignore_images = True
    converter.ignore_emphasis = False
    converter.protect_links = True
    converter.unicode_snob = True

    markdown_content = converter.handle(str(content_area))

    # Clean up excessive whitespace
    markdown_content = re.sub(r'\n{4,}', '\n\n\n', markdown_content)

    return title, markdown_content


def parse_old_index(html_content):
    """Parse the old index page and extract all article links by category."""
    soup = BeautifulSoup(html_content, 'html.parser')
    categories = {}
    current_category = None

    # Find all bold/strong tags that represent section headers
    # and all list items that contain article links
    body = soup.find('body') or soup

    # Strategy: walk through all elements and track which category we're in
    all_elements = body.find_all(['b', 'strong', 'li', 'p', 'a'])

    for elem in all_elements:
        # Check if this is a category heading (bold text)
        if elem.name in ('b', 'strong'):
            text = elem.get_text(strip=True)
            for cat_name, folder_name in OLD_INDEX_CATEGORIES:
                if cat_name.lower() in text.lower() or text.lower() in cat_name.lower():
                    current_category = folder_name
                    if current_category not in categories:
                        categories[current_category] = []
                    break

    # Now re-parse more carefully using the structure
    # The page uses <b> for categories and <ul><li> for articles
    all_text = str(body)

    for i, (cat_name, folder_name) in enumerate(OLD_INDEX_CATEGORIES):
        categories[folder_name] = []

        # Find the section between this category header and the next
        cat_pattern = re.escape(cat_name)
        match = re.search(cat_pattern, all_text, re.IGNORECASE)
        if not match:
            # Try partial match
            words = cat_name.split()
            if len(words) >= 3:
                partial = re.escape(' '.join(words[:3]))
                match = re.search(partial, all_text, re.IGNORECASE)

        if match:
            start = match.end()
            # Find next category or end
            end = len(all_text)
            if i + 1 < len(OLD_INDEX_CATEGORIES):
                next_cat = OLD_INDEX_CATEGORIES[i + 1][0]
                next_match = re.search(re.escape(next_cat), all_text[start:], re.IGNORECASE)
                if not next_match:
                    words = next_cat.split()
                    if len(words) >= 3:
                        partial = re.escape(' '.join(words[:3]))
                        next_match = re.search(partial, all_text[start:], re.IGNORECASE)
                if next_match:
                    end = start + next_match.start()

            section_html = all_text[start:end]
            section_soup = BeautifulSoup(section_html, 'html.parser')

            for link in section_soup.find_all('a', href=True):
                href = link['href']
                title = link.get_text(strip=True)
                if not title or title.lower() in ('', 'home', 'back', 'top'):
                    continue
                # Skip navigation links, email links, etc.
                if href.startswith('mailto:') or href.startswith('#') or href.startswith('javascript:'):
                    continue
                # Resolve relative URL
                full_url = urljoin(OLD_INDEX_URL, href)
                categories[folder_name].append({
                    'title': title,
                    'url': full_url,
                    'original_href': href,
                })

    return categories


def parse_new_index(html_content):
    """Parse the new index page and extract all article links by category."""
    soup = BeautifulSoup(html_content, 'html.parser')
    categories = {}
    all_text = str(soup)

    for i, (cat_name, folder_name) in enumerate(NEW_INDEX_CATEGORIES):
        categories[folder_name] = []

        # Handle partial matching for the "Responses" category
        search_name = cat_name
        if "Responses to Muslim Authors" in cat_name:
            search_name = "Responses to Muslim Authors"

        match = re.search(re.escape(search_name), all_text, re.IGNORECASE)
        if not match:
            words = search_name.split()
            if len(words) >= 3:
                partial = re.escape(' '.join(words[:3]))
                match = re.search(partial, all_text, re.IGNORECASE)

        if match:
            start = match.end()
            end = len(all_text)
            if i + 1 < len(NEW_INDEX_CATEGORIES):
                next_cat = NEW_INDEX_CATEGORIES[i + 1][0]
                next_search = next_cat
                if "Responses to Muslim Authors" in next_cat:
                    next_search = "Responses to Muslim Authors"
                next_match = re.search(re.escape(next_search), all_text[start:], re.IGNORECASE)
                if not next_match:
                    words = next_search.split()
                    if len(words) >= 3:
                        partial = re.escape(' '.join(words[:3]))
                        next_match = re.search(partial, all_text[start:], re.IGNORECASE)
                if next_match:
                    end = start + next_match.start()

            section_html = all_text[start:end]
            section_soup = BeautifulSoup(section_html, 'html.parser')

            for link in section_soup.find_all('a', href=True):
                href = link['href']
                title = link.get_text(strip=True)
                if not title or title.lower() in ('', 'home', 'back', 'top'):
                    continue
                if href.startswith('mailto:') or href.startswith('#') or href.startswith('javascript:'):
                    continue
                # New index hrefs are relative to site root, not page
                if href.startswith('http'):
                    full_url = href
                else:
                    full_url = urljoin("https://answeringislam.info/", href)
                categories[folder_name].append({
                    'title': title,
                    'url': full_url,
                    'original_href': href,
                })

    return categories


def download_article(article_info, category_dir, index_num):
    """Download a single article and save it as markdown."""
    url = article_info['url']
    title = article_info['title']

    # Create filename from title
    filename = f"{index_num:03d}_{sanitize_filename(title)}.md"
    filepath = os.path.join(category_dir, filename)

    # Skip if already downloaded
    if os.path.exists(filepath):
        print(f"  [SKIP] Already exists: {filename}")
        return filepath, True

    # Check if it's an external site we shouldn't scrape
    parsed = urlparse(url)
    if parsed.hostname and 'answeringislam' not in parsed.hostname and 'answering-islam' not in parsed.hostname and 'answer-islam' not in parsed.hostname and 'abrahamic-faith' not in parsed.hostname:
        # Save just the reference for external links
        content = f"# {title}\n\n**External Link:** [{url}]({url})\n\nThis article is hosted on an external website.\n"
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"  [EXT] Saved reference: {filename}")
        return filepath, True

    resp = make_request(url)
    if not resp:
        return None, False

    try:
        # Detect encoding
        encoding = resp.apparent_encoding or resp.encoding or 'utf-8'
        html_content = resp.content.decode(encoding, errors='replace')

        article_title, markdown_content = extract_article_content(html_content, url)

        # Use the page title if available, otherwise use link text
        display_title = article_title if article_title else title

        # Build the final markdown file
        final_content = f"# {display_title}\n\n"
        final_content += f"**Source:** [{url}]({url})\n\n"
        final_content += f"**Category:** {os.path.basename(category_dir).replace('_', ' ').title()}\n\n"
        final_content += "---\n\n"
        final_content += markdown_content

        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(final_content)

        print(f"  [OK] {filename}")
        return filepath, True

    except Exception as e:
        print(f"  [ERROR] Processing {url}: {e}")
        return None, False


def download_category(cat_folder, articles, start_from=0):
    """Download all articles in a category."""
    category_dir = os.path.join(ARTICLES_DIR, cat_folder)
    os.makedirs(category_dir, exist_ok=True)

    success_count = 0
    fail_count = 0
    failed_articles = []

    # Create category index file
    index_content = f"# {cat_folder.split('_', 1)[1].replace('_', ' ').title()}\n\n"
    index_content += f"Total articles: {len(articles)}\n\n"

    for i, article in enumerate(articles):
        num = i + 1
        print(f"  [{num}/{len(articles)}] {article['title'][:60]}...")

        filepath, success = download_article(article, category_dir, num)

        if success:
            success_count += 1
            rel_path = os.path.basename(filepath) if filepath else ""
            index_content += f"{num}. [{article['title']}]({rel_path})\n"
        else:
            fail_count += 1
            failed_articles.append(article)
            index_content += f"{num}. [FAILED] {article['title']} - {article['url']}\n"

        # Be polite - wait between requests
        if i < len(articles) - 1:
            time.sleep(DELAY_BETWEEN_REQUESTS)

    # Save category index
    index_path = os.path.join(category_dir, "00_INDEX.md")
    with open(index_path, 'w', encoding='utf-8') as f:
        f.write(index_content)

    return success_count, fail_count, failed_articles


def create_master_index(all_categories):
    """Create a master index file listing all categories and articles."""
    content = "# Sam Shamoun - Complete Article Collection\n\n"
    content += f"Source: answeringislam.info\n\n"
    content += "---\n\n"
    content += "## Table of Contents\n\n"

    total_articles = 0
    for cat_folder, articles in all_categories.items():
        display_name = cat_folder.split('_', 1)[1].replace('_', ' ').title()
        content += f"### [{display_name}]({cat_folder}/00_INDEX.md)\n"
        content += f"*{len(articles)} articles*\n\n"
        for i, article in enumerate(articles):
            filename = f"{i+1:03d}_{sanitize_filename(article['title'])}.md"
            content += f"  {i+1}. [{article['title']}]({cat_folder}/{filename})\n"
        content += "\n"
        total_articles += len(articles)

    content = content.replace("## Table of Contents",
                              f"## Table of Contents\n\n**Total: {total_articles} articles across {len(all_categories)} categories**")

    index_path = os.path.join(ARTICLES_DIR, "00_MASTER_INDEX.md")
    with open(index_path, 'w', encoding='utf-8') as f:
        f.write(content)

    print(f"\nMaster index created: {index_path}")
    return total_articles


def main():
    """Main scraping orchestrator."""
    print("=" * 60)
    print("Sam Shamoun Articles Scraper")
    print("=" * 60)

    os.makedirs(ARTICLES_DIR, exist_ok=True)

    all_categories = {}
    total_success = 0
    total_fail = 0
    all_failed = []

    # ─── Phase 1: Parse OLD index ───
    print("\n[Phase 1] Fetching OLD index page...")
    resp = make_request(OLD_INDEX_URL)
    if not resp:
        print("FATAL: Could not fetch old index page!")
        sys.exit(1)

    encoding = resp.apparent_encoding or resp.encoding or 'utf-8'
    old_html = resp.content.decode(encoding, errors='replace')
    old_categories = parse_old_index(old_html)

    for cat, articles in old_categories.items():
        print(f"  {cat}: {len(articles)} articles found")
        all_categories[cat] = articles

    time.sleep(2)

    # ─── Phase 2: Parse NEW index ───
    print("\n[Phase 2] Fetching NEW index page...")
    resp = make_request(NEW_INDEX_URL)
    if not resp:
        print("WARNING: Could not fetch new index page, continuing with old index only.")
    else:
        encoding = resp.apparent_encoding or resp.encoding or 'utf-8'
        new_html = resp.content.decode(encoding, errors='replace')
        new_categories = parse_new_index(new_html)

        for cat, articles in new_categories.items():
            print(f"  {cat}: {len(articles)} articles found")
            all_categories[cat] = articles

    # ─── Phase 3: Deduplicate ───
    print("\n[Phase 3] Deduplicating articles...")
    seen_urls = set()
    for cat in all_categories:
        deduped = []
        for article in all_categories[cat]:
            url_key = article['url'].rstrip('/').lower()
            if url_key not in seen_urls:
                seen_urls.add(url_key)
                deduped.append(article)
        removed = len(all_categories[cat]) - len(deduped)
        if removed > 0:
            print(f"  {cat}: removed {removed} duplicates")
        all_categories[cat] = deduped

    total_articles = sum(len(v) for v in all_categories.values())
    print(f"\nTotal unique articles to download: {total_articles}")

    # ─── Phase 4: Download all articles ───
    print("\n[Phase 4] Downloading articles...")
    print("=" * 60)

    for cat_folder, articles in all_categories.items():
        if not articles:
            continue
        display_name = cat_folder.split('_', 1)[1].replace('_', ' ').title()
        print(f"\n--- {display_name} ({len(articles)} articles) ---")

        success, fail, failed = download_category(cat_folder, articles)
        total_success += success
        total_fail += fail
        all_failed.extend([(cat_folder, a) for a in failed])

    # ─── Phase 5: Create master index ───
    print("\n[Phase 5] Creating master index...")
    create_master_index(all_categories)

    # ─── Phase 6: Save metadata ───
    print("\n[Phase 6] Saving metadata...")
    metadata = {
        "scraped_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "old_index_url": OLD_INDEX_URL,
        "new_index_url": NEW_INDEX_URL,
        "total_articles": total_articles,
        "successful_downloads": total_success,
        "failed_downloads": total_fail,
        "categories": {k: len(v) for k, v in all_categories.items()},
    }
    with open(METADATA_FILE, 'w') as f:
        json.dump(metadata, f, indent=2)

    # Log failures
    if all_failed:
        with open(FAILED_LOG, 'w') as f:
            for cat, article in all_failed:
                f.write(f"{cat}\t{article['title']}\t{article['url']}\n")
        print(f"\nFailed downloads logged to: {FAILED_LOG}")

    # ─── Summary ───
    print("\n" + "=" * 60)
    print("SCRAPING COMPLETE")
    print("=" * 60)
    print(f"  Total articles found:  {total_articles}")
    print(f"  Successfully downloaded: {total_success}")
    print(f"  Failed:                  {total_fail}")
    print(f"  Output directory:        {ARTICLES_DIR}")
    print(f"  Master index:            {os.path.join(ARTICLES_DIR, '00_MASTER_INDEX.md')}")
    print("=" * 60)


if __name__ == "__main__":
    main()
