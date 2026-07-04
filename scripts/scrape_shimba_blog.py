#!/usr/bin/env python3
"""
Scrape Max Shimba Ministries blog for new TEXT articles.
Skips video-only posts (word_count < 50).
Designed for GitHub Actions - no local DB dependency.
"""

import os
import re
import json
import logging
import time
import requests
from bs4 import BeautifulSoup
import html2text

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

BLOG_URL = "https://www.maxshimbaministries.org"
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARTICLES_DIR = os.path.join(REPO_ROOT, "articles", "21_max_shimba_ministries")
METADATA_FILE = os.path.join(REPO_ROOT, "data", "shimba_blog_metadata.json")
MIN_WORD_COUNT = 50
DELAY = 2
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; ShimbaScraper/1.0; +https://github.com)"
}

h2t = html2text.HTML2Text()
h2t.ignore_links = False
h2t.ignore_images = True
h2t.body_width = 0


def slugify(title: str) -> str:
    slug = title.lower().strip()
    slug = re.sub(r'[^\w\s-]', '', slug)
    slug = re.sub(r'[\s_]+', '_', slug)
    return slug[:80].strip('_')


def load_metadata() -> dict:
    if os.path.exists(METADATA_FILE):
        with open(METADATA_FILE, 'r') as f:
            return json.load(f)
    return {"scraped_urls": [], "last_run": None}


def save_metadata(meta: dict):
    os.makedirs(os.path.dirname(METADATA_FILE), exist_ok=True)
    with open(METADATA_FILE, 'w') as f:
        json.dump(meta, f, indent=2)


def get_post_links(page_url: str) -> list[dict]:
    """Extract post links from a blog page."""
    try:
        resp = requests.get(page_url, headers=HEADERS, timeout=30)
        resp.raise_for_status()
    except requests.RequestException as e:
        logger.error(f"Failed to fetch {page_url}: {e}")
        return []

    soup = BeautifulSoup(resp.text, 'html.parser')
    posts = []

    for entry in soup.select('.post-title a, h3.post-title a, h2.post-title a'):
        href = entry.get('href', '')
        title = entry.get_text(strip=True)
        if href and title:
            posts.append({"url": href, "title": title})

    return posts


def scrape_article(url: str) -> dict | None:
    """Scrape a single blog post. Returns None if video-only."""
    try:
        resp = requests.get(url, headers=HEADERS, timeout=30)
        resp.raise_for_status()
    except requests.RequestException as e:
        logger.error(f"Failed to fetch article {url}: {e}")
        return None

    soup = BeautifulSoup(resp.text, 'html.parser')

    title_el = soup.select_one('.post-title, h1.entry-title, h3.post-title')
    title = title_el.get_text(strip=True) if title_el else "Untitled"

    body_el = soup.select_one('.post-body, .entry-content')
    if not body_el:
        logger.warning(f"No content found: {url}")
        return None

    content_md = h2t.handle(str(body_el)).strip()
    word_count = len(content_md.split())

    if word_count < MIN_WORD_COUNT:
        logger.info(f"Skipping video-only post ({word_count} words): {title}")
        return None

    date_el = soup.select_one('.date-header, .published, time')
    publish_date = date_el.get_text(strip=True) if date_el else None

    return {
        "title": title,
        "url": url,
        "html": str(body_el),
        "content": content_md,
        "publish_date": publish_date,
        "word_count": word_count,
    }


def save_article(article: dict, index: int):
    """Save article as markdown file using the universal formatter."""
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from format_article import format_article, slugify as fmt_slugify

    os.makedirs(ARTICLES_DIR, exist_ok=True)
    slug = fmt_slugify(article["title"])
    if not slug:
        slug = f"article_{index}"
    filename = f"{index:03d}_{slug}.md"
    filepath = os.path.join(ARTICLES_DIR, filename)

    if os.path.exists(filepath):
        return  # Don't overwrite

    # Get the raw HTML from the article (re-fetch if needed)
    html_content = article.get("html", f"<p>{article['content']}</p>")

    result = format_article(
        title=article["title"],
        html_content=html_content,
        source_url=article["url"],
        category_id=21,
        category_name="Max Shimba Ministries",
        source_name="Max Shimba Ministries",
    )

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(result)
    logger.info(f"Saved: {filename}")


def get_existing_count() -> int:
    """Count existing articles to continue numbering."""
    if not os.path.exists(ARTICLES_DIR):
        return 0
    return len([f for f in os.listdir(ARTICLES_DIR) if f.endswith('.md')])


def main():
    logger.info("Starting Max Shimba blog scraper")
    meta = load_metadata()
    scraped_urls = set(meta.get("scraped_urls", []))
    existing_count = get_existing_count()
    new_count = 0

    # Scrape main page and pagination
    page_url = BLOG_URL
    for page_num in range(1, 11):  # Max 10 pages
        logger.info(f"Fetching page {page_num}: {page_url}")
        posts = get_post_links(page_url)

        if not posts:
            break

        for post in posts:
            if post["url"] in scraped_urls:
                continue

            time.sleep(DELAY)
            article = scrape_article(post["url"])

            if article:
                existing_count += 1
                save_article(article, existing_count)
                new_count += 1

            scraped_urls.add(post["url"])

        # Find next page link
        try:
            resp = requests.get(page_url, headers=HEADERS, timeout=30)
            soup = BeautifulSoup(resp.text, 'html.parser')
            older = soup.select_one('#blog-pager-older-link a, a.blog-pager-older-link')
            if older and older.get('href'):
                page_url = older['href']
            else:
                break
        except Exception:
            break

    meta["scraped_urls"] = list(scraped_urls)
    meta["last_run"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    save_metadata(meta)

    logger.info(f"Done. New articles saved: {new_count}")


if __name__ == "__main__":
    main()
