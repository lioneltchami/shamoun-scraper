#!/usr/bin/env python3
"""
Scrape @shimbatheologicalinstitute YouTube channel for new video metadata.
Uses yt-dlp, no browser needed. GitHub Actions compatible.
"""

import json
import re
import os
import sys
import logging
import requests
from datetime import datetime
from typing import Optional

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

try:
    import yt_dlp
except ImportError:
    sys.exit("Install yt-dlp: pip install yt-dlp")

CHANNEL_URL = "https://www.youtube.com/@shimbatheologicalinstitute/videos"
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
OUTPUT_JSON = os.path.join(DATA_DIR, "shimba_youtube_videos.json")

KEYWORDS = [
    "islam", "muslim", "quran", "muhammad", "allah", "hadith", "mosque",
    "sharia", "jihad", "kafir", "haram", "halal", "surah", "ayah", "ummah",
    "dawah", "fatwa", "imam", "mufti", "sheikh", "burqa", "hijab", "ramadan",
    "eid", "dua", "jinn", "sunnah", "salah", "wudu", "zakat",
]
KEYWORD_PATTERN = re.compile(r"\b(" + "|".join(KEYWORDS) + r")\b", re.IGNORECASE)


def matches_keywords(title: str, description: str) -> list[str]:
    text = f"{title} {description}"
    return list(set(KEYWORD_PATTERN.findall(text.lower())))


def load_existing() -> dict:
    """Load existing video data, keyed by URL."""
    if os.path.exists(OUTPUT_JSON):
        with open(OUTPUT_JSON, 'r') as f:
            videos = json.load(f)
        return {v["video_url"]: v for v in videos}
    return {}


def extract_videos() -> list:
    """Extract all video metadata from channel."""
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "skip_download": True,
        "ignoreerrors": True,
    }

    videos = []
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(CHANNEL_URL, download=False)
        if not info:
            logger.error("Could not extract channel info")
            return []

        entries = info.get("entries", [])
        for entry in entries:
            if not entry:
                continue
            url = entry.get("url") or f"https://www.youtube.com/watch?v={entry.get('id', '')}"
            videos.append({
                "title": entry.get("title", ""),
                "video_url": url,
                "id": entry.get("id", ""),
                "duration": entry.get("duration"),
            })

    logger.info(f"Found {len(videos)} total channel videos")
    return videos


def enrich_video(video_url: str) -> Optional[dict]:
    """Get full metadata + subtitles for a single video."""
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "ignoreerrors": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["en"],
        "subtitlesformat": "vtt",
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(video_url, download=False)
            if not info:
                return None

            # Extract subtitle text
            transcript = extract_subtitles(info)

            return {
                "title": info.get("title", ""),
                "description": info.get("description", ""),
                "upload_date": info.get("upload_date", ""),
                "video_url": video_url,
                "duration": info.get("duration"),
                "thumbnail_url": info.get("thumbnail", ""),
                "view_count": info.get("view_count"),
                "transcript": transcript,
                "has_transcript": bool(transcript),
            }
    except Exception as e:
        logger.warning(f"Failed to enrich {video_url}: {e}")
        return None


def extract_subtitles(info: dict) -> str:
    """Extract auto-generated subtitles and clean them into readable text."""
    import tempfile

    video_id = info.get("id", "")
    # Check for auto-captions
    auto_subs = info.get("automatic_captions", {})
    manual_subs = info.get("subtitles", {})

    # Prefer manual English subs, fall back to auto-generated
    subs = manual_subs.get("en") or auto_subs.get("en")
    if not subs:
        return ""

    # Find vtt or srv1 format URL
    sub_url = None
    for fmt in subs:
        if fmt.get("ext") in ("vtt", "srv1", "json3"):
            sub_url = fmt.get("url")
            break
    if not sub_url and subs:
        sub_url = subs[0].get("url")

    if not sub_url:
        return ""

    try:
        resp = requests.get(sub_url, timeout=15)
        if resp.status_code != 200:
            return ""
        return clean_vtt(resp.text)
    except Exception as e:
        logger.warning(f"Failed to download subtitles for {video_id}: {e}")
        return ""


def clean_vtt(vtt_text: str) -> str:
    """Strip VTT timestamps and formatting, return clean text."""
    lines = vtt_text.split("\n")
    text_lines = []
    seen = set()

    for line in lines:
        line = line.strip()
        # Skip headers, timestamps, empty lines
        if not line or line.startswith("WEBVTT") or line.startswith("Kind:") or line.startswith("Language:"):
            continue
        if re.match(r"^\d{2}:\d{2}:\d{2}", line):
            continue
        if re.match(r"^\d+$", line):
            continue
        # Remove VTT tags like <c> </c> <00:00:01.234>
        line = re.sub(r"<[^>]+>", "", line)
        line = line.strip()
        if not line:
            continue
        # Deduplicate (VTT repeats lines across cues)
        if line not in seen:
            seen.add(line)
            text_lines.append(line)

    return " ".join(text_lines)


def main():
    logger.info("Starting YouTube channel scraper")
    os.makedirs(DATA_DIR, exist_ok=True)

    existing = load_existing()
    logger.info(f"Existing videos in database: {len(existing)}")

    channel_videos = extract_videos()
    new_videos = [v for v in channel_videos if v["video_url"] not in existing]
    logger.info(f"New videos to process: {len(new_videos)}")

    added = 0
    for video in new_videos:
        enriched = enrich_video(video["video_url"])
        if not enriched:
            continue

        keywords = matches_keywords(enriched["title"], enriched.get("description", ""))
        enriched["matched_keywords"] = keywords
        enriched["is_islam_related"] = len(keywords) > 0
        enriched["scraped_at"] = datetime.utcnow().isoformat() + "Z"

        existing[video["video_url"]] = enriched
        added += 1

    # Save all videos
    all_videos = sorted(existing.values(), key=lambda v: v.get("upload_date", ""), reverse=True)
    with open(OUTPUT_JSON, 'w') as f:
        json.dump(all_videos, f, indent=2)

    logger.info(f"Done. New videos added: {added}. Total: {len(all_videos)}")


if __name__ == "__main__":
    main()
