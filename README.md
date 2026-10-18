# Text search on static datasets with RawTree

Full-text search and analytics demos on large, static, long-text datasets, the static counterpart of [bluesky-fulltext-poc](https://github.com/rawtreedb/bluesky-fulltext-poc). One Node.js server serves a landing page and one UI + API per dataset:

| Path | Dataset | API |
|---|---|---|
| `/wikipedia/` | Wikipedia articles (`wikimedia/wikipedia` on Hugging Face) + hourly pageviews (`dumps.wikimedia.org/other/pageviews`) | `/api/wikipedia/<route>` |
| `/stackoverflow/` | Stack Overflow posts 2008-2024 (ClickHouse public Parquet dataset) | `/api/stackoverflow/<route>` |
| `/hackernews/` | Hacker News items from the 2023-08-18 public Parquet snapshot | `/api/hackernews/<route>` |
| `/amazon/` | Amazon customer reviews from the 1990s through 2015 | `/api/amazon/<route>` |
| `/arxiv/` | arXiv paper metadata and abstracts (`librarian-bots/arxiv-metadata-snapshot`) | `/api/arxiv/<route>` |
| `/reddit/` | Reddit comments from 2012-01 through 2016-02 (`fddemarco/pushshift-reddit-comments`) | `/api/reddit/<route>` |
| `/gutenberg/` | Project Gutenberg whole books (`sedthh/gutenberg_english`) | `/api/gutenberg/<route>` |
| `/loghub/` | Loghub v1 system logs (Zenodo, CC-BY-4.0) | `/api/loghub/<route>` |
| `/laion/` (opt-in; disabled by default) | LAION-400M image URLs, captions and CLIP ViT-B/32 image embeddings | `/api/laion/<route>` |

Each dataset lives in `datasets/<id>/`: `api.mjs` (routes), `public/` (UI), and its loader scripts. `lib/rawtree.mjs` is the shared RawTree API client. `server.mjs` loads the datasets listed in `DATASETS` (default `wikipedia,stackoverflow,hackernews,amazon,arxiv,reddit,gutenberg,loghub`).

LAION remains in the repository but is disabled by default. To serve `/laion/`, add `laion` to `DATASETS` (for example, `DATASETS=wikipedia,stackoverflow,laion`) and load its data with `node datasets/laion/load.mjs`.

## Datasets and tables

Tables are raw RawTree tables (`__raw_data JSON`) holding the source rows, like `bluesky_posts` in the Bluesky demo.

| Table | Source | Rows | Loader |
|---|---|---|---|
| `wikipedia_articles` | [`wikimedia/wikipedia`](https://huggingface.co/datasets/wikimedia/wikipedia) `20231101.en`, 41 Parquet files (11.6 GB): `id, url, title, text` | 6.4M | `datasets/wikipedia/load.mjs` |
| `wikipedia_pageviews` | [hourly pageview dumps](https://dumps.wikimedia.org/other/pageviews/), `en` (desktop) and `en.m` (mobile) lines: `domain_code, page_title, count_views, total_response_size, hour` | ~2.1M per hour (~350M per week) | `datasets/wikipedia/load_pageviews.mjs` |
| `stackoverflow_posts` | [ClickHouse public dataset](https://datasets-documentation.s3.eu-west-3.amazonaws.com/stackoverflow/parquet/posts/2008.parquet), one Parquet file per year 2008-2024 (38 GB): `Id, PostTypeId, ParentId, Title, Body, Tags, Score, ViewCount, CreationDate, ...` | ~60M | `datasets/stackoverflow/load.mjs` |
| `hackernews_items` | [Hacker News public dataset](https://datasets-documentation.s3.eu-west-3.amazonaws.com/hackernews/2023-08-18.parquet): `id, deleted, type, by, time, text, dead, parent, url, score, title, ...` | 37,171,166 | `datasets/hackernews/load.mjs` |
| `amazon_reviews` | [Amazon Reviews Parquet files](https://datasets-documentation.s3.eu-west-3.amazonaws.com/amazon_reviews/): 1990s, 2000s, and 2010-2015 files | All source rows | `datasets/amazon/load.mjs` |
| `arxiv_papers` | [`librarian-bots/arxiv-metadata-snapshot`](https://huggingface.co/datasets/librarian-bots/arxiv-metadata-snapshot), 11 Parquet files: `id, title, authors, categories, abstract, versions, update_date` | All source rows | `datasets/arxiv/load.mjs` |
| `reddit_comments` | [`fddemarco/pushshift-reddit-comments`](https://huggingface.co/datasets/fddemarco/pushshift-reddit-comments), monthly Parquet files `RC_2012-01` through `RC_2016-02` | ~1.9B | `datasets/reddit/load.mjs` |
| `gutenberg_books` | [`sedthh/gutenberg_english`](https://huggingface.co/datasets/sedthh/gutenberg_english), 37 Parquet files; one row per whole book | 48,284 | `datasets/gutenberg/load.mjs` |
| `loghub_lines` | [Loghub v1](https://zenodo.org/records/8196385), streamed from 19 `.zip`/`.tar.gz` archives | ~495M | `datasets/loghub/load.mjs` |
| `laion_images` | [LAION-400M embeddings](https://deploy.laion.ai/8f83b608504d46bb81708ec86e912220/embeddings/), aligned `metadata/metadata_{N}.parquet` and `img_emb/img_emb_{N}.npy`: public `url`, `caption`, LAION caption-image similarity, original dimensions and normalized 512-d CLIP ViT-B/32 image vector | 2M rows per shard ID range (shard 0 has 1,000,448 rows) | `datasets/laion/load.mjs` |

The article, Stack Overflow, four text-dataset, and Gutenberg loaders use server-side URL imports (`POST /v1/tables/<table>?url=...`), one file per request; Hugging Face redirects are resolved first because the import does not follow redirects. Loghub streams archive entries and inserts deterministic JSON batches. The pageview dumps are space-separated text, so that loader streams and parses them locally and inserts JSON batches. All loaders record finished files or archive entries in `$DATA_DIR` and use insert deduplication tokens, so re-running one resumes without duplicates. Text loaders add missing text indexes and materialize them after the first imported file or batch; later inserts build the index as they load.

```bash
node datasets/wikipedia/load.mjs                      # --langs en --snapshot 20231101 --files N (first N files per language)
node datasets/wikipedia/load_pageviews.mjs            # --from 2023-10-25 --days 7 --wikis en,en.m --concurrency 3
node datasets/stackoverflow/load.mjs                  # --from 2008 --to 2024
node datasets/hackernews/load.mjs
node datasets/amazon/load.mjs                         # --from 0 --to 7, or --files <name-or-index,...>
node datasets/arxiv/load.mjs                          # --files 11 (first N files)
node datasets/reddit/load.mjs                         # --from 2012-01 --to 2016-02
node datasets/gutenberg/load.mjs
node datasets/loghub/load.mjs
node datasets/laion/check_alignment.mjs                # check 200 random shard-0 image/caption vector pairs first
node datasets/laion/load.mjs                           # --from 0 --to 0 --table laion_images --batch 2000
```

The LAION loader keeps successful rows marked `NSFW=UNLIKELY` with HTTPS URLs and non-empty, non-NSFW captions, and drops image vectors whose CLIP unsafe probability is at least `0.92`. It downloads both source files into `$DATA_DIR`, decodes the aligned NPY float16 vectors, normalizes them, and inserts resumable batches with per-batch deduplication tokens. A shard is marked done only after all its batches finish. It creates `laion_images` with sorting key `id` before its first insert.

### Text indexes

Created through the query API before (or after) loading; `MATERIALIZE` builds them for parts inserted before the index existed. The search conditions use the exact same expressions, so the JS tokenizer in `lib/search.mjs` mirrors `splitByNonAlpha` on lowercased text.

```sql
ALTER TABLE wikipedia_articles ADD INDEX idx_title lowerUTF8(__raw_data.title::String) TYPE text(tokenizer = splitByNonAlpha);
ALTER TABLE wikipedia_articles ADD INDEX idx_text lowerUTF8(__raw_data.text::String) TYPE text(tokenizer = splitByNonAlpha);
ALTER TABLE stackoverflow_posts ADD INDEX idx_title lowerUTF8(__raw_data.Title::String) TYPE text(tokenizer = splitByNonAlpha);
ALTER TABLE stackoverflow_posts ADD INDEX idx_body lowerUTF8(__raw_data.Body::String) TYPE text(tokenizer = splitByNonAlpha);
ALTER TABLE hackernews_items ADD INDEX idx_title lowerUTF8(__raw_data.title::String) TYPE text(tokenizer = splitByNonAlpha);
ALTER TABLE hackernews_items ADD INDEX idx_text lowerUTF8(__raw_data.text::String) TYPE text(tokenizer = splitByNonAlpha);
ALTER TABLE amazon_reviews ADD INDEX idx_review_headline lowerUTF8(__raw_data.review_headline::String) TYPE text(tokenizer = splitByNonAlpha);
ALTER TABLE amazon_reviews ADD INDEX idx_review_body lowerUTF8(__raw_data.review_body::String) TYPE text(tokenizer = splitByNonAlpha);
ALTER TABLE arxiv_papers ADD INDEX idx_title lowerUTF8(__raw_data.title::String) TYPE text(tokenizer = splitByNonAlpha);
ALTER TABLE arxiv_papers ADD INDEX idx_abstract lowerUTF8(__raw_data.abstract::String) TYPE text(tokenizer = splitByNonAlpha);
ALTER TABLE reddit_comments ADD INDEX idx_body lowerUTF8(__raw_data.body::String) TYPE text(tokenizer = splitByNonAlpha);
ALTER TABLE gutenberg_books ADD INDEX idx_text lowerUTF8(__raw_data.TEXT::String) TYPE text(tokenizer = splitByNonAlpha);
ALTER TABLE loghub_lines ADD INDEX idx_message lowerUTF8(__raw_data.message::String) TYPE text(tokenizer = splitByNonAlpha);
ALTER TABLE laion_images ADD INDEX idx_caption lowerUTF8(__raw_data.caption::String) TYPE text(tokenizer = splitByNonAlpha);
ALTER TABLE laion_images ADD INDEX vector_idx __raw_data.vector::Array(Float32) TYPE vector_similarity('hnsw', 'cosineDistance', 512);
ALTER TABLE wikipedia_articles MATERIALIZE INDEX idx_title;  -- likewise for indexes added after loading
ALTER TABLE hackernews_items MATERIALIZE INDEX idx_title;  -- each loader materializes its initial indexes once
ALTER TABLE hackernews_items MATERIALIZE INDEX idx_text;
ALTER TABLE amazon_reviews MATERIALIZE INDEX idx_review_headline;
ALTER TABLE amazon_reviews MATERIALIZE INDEX idx_review_body;
ALTER TABLE arxiv_papers MATERIALIZE INDEX idx_title;
ALTER TABLE arxiv_papers MATERIALIZE INDEX idx_abstract;
ALTER TABLE reddit_comments MATERIALIZE INDEX idx_body;
ALTER TABLE gutenberg_books MATERIALIZE INDEX idx_text;
ALTER TABLE loghub_lines MATERIALIZE INDEX idx_message;
ALTER TABLE laion_images MATERIALIZE INDEX idx_caption;
ALTER TABLE laion_images MATERIALIZE INDEX vector_idx;
```

Don't add a text index on `wikipedia_pageviews.page_title`: checking the `page_title IN matches` set against it per granule made the pageviews join about 10x slower (10 s vs 1 s).

## API

Every text dataset serves `GET /api/<dataset>/search`, `/analytics` and `/stats`; text search supports `mode=all|any|phrase`. Hacker News supports title/text fields, story/comment types, author, year and score/recent sorting; Amazon reviews support headline/body, exact category, rating, verified-purchase, year and helpful/recent filters; arXiv supports title/abstract, archive-category prefixes and first-submission year; Reddit supports subreddit, author, year and score/recent sorting. Reddit body text is preserved in the pre-tokenized form used by its Hugging Face mirror. Gutenberg indexes whole books and searches text, title or author; Loghub searches 19 archive systems and retains unmatched lines with fallback message text (formats without a year have null timestamps). The LAION image API serves `/api/laion/images` (`q`, `mode=semantic|caption`, `similar=<id>`, `limit`), `/api/laion/analytics` and `/api/laion/stats`. Semantic image search uses CLIP text embeddings and the vector index; caption mode requires all query tokens and sorts by LAION's caption-image similarity. Unsafe text queries are blocked. Every search response includes the SQL sent to RawTree and its statistics, which the UI exposes in the query panel.

## Run locally

```bash
npm ci
export RAWTREE_API_KEY=rt_...        # read_write key
node server.mjs                      # http://localhost:3000
```

| Env var | Default | Meaning |
|---|---|---|
| `RAWTREE_API_KEY` | required | Key used by the loaders (and for queries if no query key) |
| `RAWTREE_QUERY_API_KEY` | `RAWTREE_API_KEY` | Optional `read_only` key for search queries |
| `RAWTREE_DATABASE` | `default` | Database |
| `RAWTREE_API_URL` | `https://api.rawtree.com` | API base URL |
| `DATASETS` | `wikipedia,stackoverflow,hackernews,amazon,arxiv,reddit,gutenberg,loghub` | Datasets to serve |
| `DATA_DIR` | `/data` | Loader download and resume-state directory |
| `PORT` | `3000` | HTTP port |

## Deploy

`docker-compose.yml` runs the app behind Caddy (`DOMAIN=:80` serves plain HTTP until there is a hostname). Every push to `main` runs `.github/workflows/deploy.yml`: `npm run check` and `docker build`, then it installs Docker on the VM if missing, rsyncs the code, writes the VM's `.env` from repository secrets/variables, runs `docker compose up -d --build` and waits for `/healthz`. PRs only run the check and build.

One-time setup:

1. VM with ports 80/443 open and port 22 reachable from GitHub Actions runners (key-only auth).
2. Add repository (or `production` environment) secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (private key), `DEPLOY_KNOWN_HOSTS` (`ssh-keyscan -t ed25519 <host>`), `RAWTREE_API_KEY` and optionally `RAWTREE_QUERY_API_KEY`.
3. Optional variables `DOMAIN` (default `textsearch.rawtree.dev`; `:80` serves plain HTTP on the IP) and `RAWTREE_DATABASE` (default `default`).

Loaders run on the VM as detached one-off containers via the "Load dataset" workflow (`.github/workflows/load.yml`), or by hand with `docker compose run -d --rm --name load-x app node datasets/<id>/<loader>.mjs [args]`.
