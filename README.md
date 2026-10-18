# Text search on static datasets with RawTree

Full-text search and analytics demos on large, static, long-text datasets, the static counterpart of [bluesky-fulltext-poc](https://github.com/rawtreedb/bluesky-fulltext-poc). One Node.js server serves a landing page and one UI + API per dataset:

| Path | Dataset | API |
|---|---|---|
| `/wikipedia/` | Wikipedia articles (`wikimedia/wikipedia` on Hugging Face) + hourly pageviews (`dumps.wikimedia.org/other/pageviews`) | `/api/wikipedia/<route>` |
| `/stackoverflow/` | Stack Overflow posts 2008-2024 (ClickHouse public Parquet dataset) | `/api/stackoverflow/<route>` |

Each dataset lives in `datasets/<id>/`: `api.mjs` (routes), `public/` (UI), and its loader scripts. `lib/rawtree.mjs` is the shared RawTree API client. `server.mjs` loads the datasets listed in `DATASETS` (default `wikipedia,stackoverflow`).

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

`docker-compose.yml` runs the app behind Caddy (`DOMAIN=:80` serves plain HTTP until there is a hostname). Every push to `main` runs `.github/workflows/deploy.yml`: `npm run check` and `docker build`, then it installs Docker on the VM if missing, rsyncs the code (keeping the VM's `.env`), runs `docker compose up -d --build` and waits for `/healthz`. PRs only run the check and build.

One-time setup:

1. VM with ports 80/443 open and port 22 reachable from GitHub Actions runners (key-only auth).
2. On the VM, create `~/textsearch-poc/.env` from `.env.example`.
3. Add repository secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (private key) and `DEPLOY_KNOWN_HOSTS` (`ssh-keyscan -t ed25519 <host>`), in the `production` environment.

Loaders run on the VM as detached one-off containers via the "Load dataset" workflow (`.github/workflows/load.yml`), or by hand with `docker compose run -d --rm --name load-x app node datasets/<id>/<loader>.mjs [args]`.
