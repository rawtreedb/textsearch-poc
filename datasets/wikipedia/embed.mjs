import os from 'node:os';
import { loadParquetEmbeddings } from '../../lib/embed_loader.mjs';
import { options } from '../../lib/loader.mjs';

const opts = options({
    snapshot: '20231101',
    lang: 'en',
    table: 'wikipedia_vectors',
    files: 0,
    limit: 0,
    workers: Math.max(1, Math.floor((os.availableParallelism() - 2) / 2)),
    threads: Number(process.env.ORT_INTRA_OP_NUM_THREADS) || 2,
    batch: 1000,
});
const fileLimit = Number(opts.files);
if (!Number.isInteger(fileLimit) || fileLimit < 0)
    throw new Error('--files must be a non-negative integer');
const HF = 'https://huggingface.co';

async function parquetFiles()
{
    const response = await fetch(`${HF}/api/datasets/wikimedia/wikipedia/tree/main/${opts.snapshot}.${opts.lang}`);
    if (!response.ok)
        throw new Error(`Hugging Face listing ${opts.snapshot}.${opts.lang}: HTTP ${response.status}`);
    const files = (await response.json()).map((entry) => entry.path).filter((file) => file.endsWith('.parquet')).sort();
    return fileLimit > 0 ? files.slice(0, fileLimit) : files;
}

async function resolveRedirect(file)
{
    const response = await fetch(`${HF}/datasets/wikimedia/wikipedia/resolve/main/${file}`, { redirect: 'manual' });
    const location = response.headers.get('location');
    if (!location)
        throw new Error(`${file}: expected a redirect, got HTTP ${response.status}`);
    return new URL(location, HF).href;
}

const files = await parquetFiles();
await loadParquetEmbeddings({
    table: opts.table,
    sortingKey: 'id',
    files: await Promise.all(files.map(async (key) => ({ key, url: await resolveRedirect(key) }))),
    columns: ['id', 'title', 'url', 'text'],
    isIncluded: () => true,
    textFor: (row) => `${row.title ?? ''}\n${row.text ?? ''}`,
    recordFor: (row, vector) => ({ id: row.id, title: row.title, url: row.url, vector }),
    options: opts,
    totalEstimate: 6_400_000,
});
