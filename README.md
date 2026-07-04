# Shamoun Scraper

Public scraping and ingestion repository for the Shamoun content library.

This repo is responsible for:

- scraping Sam Shamoun and Max Shimba content
- committing scraped markdown and metadata for auditability
- ingesting article content into the Shamoun VPS Supabase backend
- validating that ingest results are still healthy

## Secrets

GitHub Actions requires these repository secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Local usage

```bash
pip install -r requirements-scraper.txt
npm install

SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run db:ingest
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run db:validate
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run db:audit-contract
```
