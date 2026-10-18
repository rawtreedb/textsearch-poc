# Text search on static datasets with RawTree

Full-text search and analytics demos on large, static, long-text datasets, the static counterpart of [bluesky-fulltext-poc](https://github.com/rawtreedb/bluesky-fulltext-poc). One Node.js server serves a landing page and one UI + API per dataset:

| Path | Dataset | API |
|---|---|---|
| `/wikipedia/` | Wikipedia articles (`wikimedia/wikipedia` on Hugging Face) + hourly pageviews (`dumps.wikimedia.org/other/pageviews`) | `/api/wikipedia/<route>` |
| `/stackoverflow/` | Stack Overflow posts 2008-2024 (ClickHouse public Parquet dataset) | `/api/stackoverflow/<route>` |
| `/laion/` (opt-in; disabled by default) | LAION-400M image URLs, captions and CLIP ViT-B/32 image embeddings | `/api/laion/<route>` |

Each dataset lives in `datasets/<id>/`: `api.mjs` (routes), `public/` (UI), and its loader scripts. `lib/rawtree.mjs` is the shared RawTree API client. `server.mjs` loads the datasets listed in `DATASETS` (default `wikipedia,stackoverflow`).

LAION remains in the repository but is disabled by default. To serve `/laion/`, add `laion` to `DATASETS` (for example, `DATASETS=wikipedia,stackoverflow,laion`) and load its data with `node datasets/laion/load.mjs`.

## Datasets and tables

Tables are raw RawTree tables (`__raw_data JSON`) holding the source rows, like `bluesky_posts` in the Bluesky demo.

| Table | Source | Rows | Loader |
|---|---|---|---|
| `wikipedia_articles` | [`wikimedia/wikipedia`](https://huggingface.co/datasets/wikimedia/wikipedia) `20231101.en`, 41 Parquet files (11.6 GB): `id, url, title, text` | 6.4M | `datasets/wikipedia/load.mjs` |
| `wikipedia_pageviews` | [hourly pageview dumps](https://dumps.wikimedia.org/other/pageviews/), `en` (desktop) and `en.m` (mobile) lines: `domain_code, page_title, count_views, total_response_size, hour` | ~2.1M per hour (~350M per week) | `datasets/wikipedia/load_pageviews.mjs` |
| `stackoverflow_posts` | [ClickHouse public dataset](https://datasets-documentation.s3.eu-west-3.amazonaws.com/stackoverflow/parquet/posts/2008.parquet), one Parquet file per year 2008-2024 (38 GB): `Id, PostTypeId, ParentId, Title, Body, Tags, Score, ViewCount, CreationDate, ...` | ~60M | `datasets/stackoverflow/load.mjs` |
| `laion_images` | [LAION-400M embeddings](https://deploy.laion.ai/8f83b608504d46bb81708ec86e912220/embeddings/), aligned `metadata/metadata_{N}.parquet` and `img_emb/img_emb_{N}.npy`: public `url`, `caption`, LAION caption-image similarity, original dimensions and normalized 512-d CLIP ViT-B/32 image vector | 2M rows per shard ID range (shard 0 has 1,000,448 rows) | `datasets/laion/load.mjs` |

The article and Stack Overflow loaders use server-side URL imports (`POST /v1/tables/<table>?url=...`), one file per request; Hugging Face's redirect is resolved first because the import does not follow redirects. The pageview dumps are space-separated text, so that loader streams and parses them locally and inserts JSON batches. All loaders record finished files in `$DATA_DIR/<table>.done.json` and use insert deduplication tokens, so re-running one resumes without duplicates.

```bash
node datasets/wikipedia/load.mjs                      # --langs en --snapshot 20231101 --files N (first N files per language)
node datasets/wikipedia/load_pageviews.mjs            # --from 2023-10-25 --days 7 --wikis en,en.m --concurrency 3
node datasets/stackoverflow/load.mjs                  # --from 2008 --to 2024
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
ALTER TABLE laion_images ADD INDEX idx_caption lowerUTF8(__raw_data.caption::String) TYPE text(tokenizer = splitByNonAlpha);
ALTER TABLE laion_images ADD INDEX vector_idx __raw_data.vector::Array(Float32) TYPE vector_similarity('hnsw', 'cosineDistance', 512);
ALTER TABLE wikipedia_articles MATERIALIZE INDEX idx_title;  -- likewise for indexes added after loading
ALTER TABLE laion_images MATERIALIZE INDEX idx_caption;
ALTER TABLE laion_images MATERIALIZE INDEX vector_idx;
```

Don't add a text index on `wikipedia_pageviews.page_title`: checking the `page_title IN matches` set against it per granule made the pageviews join about 10x slower (10 s vs 1 s).

## API

Wikipedia and Stack Overflow serve `GET /api/<dataset>/search`, `/analytics` and `/stats`. The LAION image API serves `/api/laion/images` (`q`, `mode=semantic|caption`, `similar=<id>`, `limit`), `/api/laion/analytics` and `/api/laion/stats`. Semantic image search uses CLIP text embeddings and the vector index; caption mode requires all query tokens and sorts by LAION's caption-image similarity. Unsafe text queries are blocked. Every search response includes the SQL sent to RawTree and its statistics, which the UI exposes in the query panel.

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
| `DATASETS` | `wikipedia,stackoverflow` | Datasets to serve |
| `DATA_DIR` | `/data` | Loader download and resume-state directory |
| `PORT` | `3000` | HTTP port |

## Deploy

`docker-compose.yml` runs the app behind Caddy (`DOMAIN=:80` serves plain HTTP until there is a hostname). Every push to `main` runs `.github/workflows/deploy.yml`: `npm run check` and `docker build`, then it installs Docker on the VM if missing, rsyncs the code, writes the VM's `.env` from repository secrets/variables, runs `docker compose up -d --build` and waits for `/healthz`. PRs only run the check and build.

One-time setup:

1. VM with ports 80/443 open and port 22 reachable from GitHub Actions runners (key-only auth).
2. Add repository (or `production` environment) secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (private key), `DEPLOY_KNOWN_HOSTS` (`ssh-keyscan -t ed25519 <host>`), `RAWTREE_API_KEY` and optionally `RAWTREE_QUERY_API_KEY`.
3. Optional variables `DOMAIN` (default `textsearch.rawtree.dev`; `:80` serves plain HTTP on the IP) and `RAWTREE_DATABASE` (default `default`).

Loaders run on the VM as detached one-off containers via the "Load dataset" workflow (`.github/workflows/load.yml`), or by hand with `docker compose run -d --rm --name load-x app node datasets/<id>/<loader>.mjs [args]`.
