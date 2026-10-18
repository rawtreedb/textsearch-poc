// Loads LAION-400M caption metadata and aligned CLIP ViT-B/32 image embeddings into a RawTree raw table.
// Usage: node datasets/laion/load.mjs [--from 0] [--to 0] [--table laion_images] [--batch 2000]
import { DATA_DIR, doneSet, log, options } from '../../lib/loader.mjs';
import { clipUnsafe } from '../../lib/clip.mjs';
import { createTable, describeTable, execute, insert, listTables, literal, query } from '../../lib/rawtree.mjs';
import { isNsfwText } from '../../lib/nsfw_text.mjs';
import { downloadShard, normalizedHalfVector, openVectors, readMetadata } from './source.mjs';

const opts = options({ from: 0, to: 0, table: 'laion_images', batch: 2000 });
const firstShard = Number(opts.from);
const lastShard = Number(opts.to);
const batchSize = Number(opts.batch);
const table = opts.table;
if (!Number.isInteger(firstShard) || !Number.isInteger(lastShard) || firstShard < 0 || lastShard < firstShard)
    throw new Error('Expected --from and --to to be non-negative shard numbers with --to >= --from');
if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new Error('--batch must be a positive integer');
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table))
    throw new Error(`Invalid table name: ${table}`);

const done = doneSet(table);
const EXPECTED_COLUMNS = new Set(['id', 'shard', 'url', 'caption', 'similarity', 'width', 'height', 'license', 'clip_unsafe', 'vector']);
const INDEXES = [
    `ALTER TABLE ${table} ADD INDEX idx_caption lowerUTF8(__raw_data.caption::String) TYPE text(tokenizer = splitByNonAlpha)`,
    `ALTER TABLE ${table} ADD INDEX vector_idx __raw_data.vector::Array(Float32) TYPE vector_similarity('hnsw', 'cosineDistance', 512)`,
];

async function ensureTable()
{
    const { tables } = await listTables();
    const exists = tables.some((entry) => entry.name === table);
    if (!exists)
        await createTable(table, 'id');

    const { table: info } = await describeTable(table);
    if (info.sorting_key.trim() !== 'id')
        throw new Error(`${table} has sorting key ${JSON.stringify(info.sorting_key)}, expected "id"; refusing to load`);
    if (Number(info.total_rows) > 0)
    {
        const columns = new Set(info.columns.map((column) => column.name));
        const missing = [...EXPECTED_COLUMNS].filter((name) => !columns.has(name));
        if (missing.length)
            throw new Error(`${table} already contains rows but is missing expected fields (${missing.join(', ')}); refusing to load`);
    }

    const { data: indexes } = await query(`SELECT name FROM system.data_skipping_indices WHERE database = ${literal(process.env.RAWTREE_DATABASE ?? 'default')} AND table = ${literal(table)}`);
    const existing = new Set(indexes.map((index) => index.name));
    for (let index = 0; index < INDEXES.length; index++)
    {
        const name = index === 0 ? 'idx_caption' : 'vector_idx';
        if (!existing.has(name))
        {
            log('create index', name);
            await execute(INDEXES[index]);
        }
    }
}

async function loadShard(shard)
{
    if (done.has(String(shard)))
    {
        log('skip completed shard', shard);
        return;
    }

    const files = await downloadShard(shard);
    const metadata = await readMetadata(files.metadata);
    const embeddings = await openVectors(files.embeddings);
    if (metadata.length !== embeddings.rows || embeddings.dimensions !== 512)
    {
        await embeddings.close();
        throw new Error(`Shard ${shard} metadata/embedding dimensions differ: ${metadata.length} rows vs ${embeddings.rows}x${embeddings.dimensions}`);
    }

    const drops = { status: 0, nsfw: 0, url: 0, caption_empty: 0, text_nsfw: 0, clip_unsafe: 0 };
    let batch = [];
    let batchStart = 0;
    let inserted = 0;
    let lastProgress = 0;
    const flush = async () =>
    {
        if (!batch.length)
            return;
        await insert(table, batch, { dedupToken: `laion-${shard}-${batchStart}` });
        inserted += batch.length;
        batch = [];
    };

    try
    {
        for (let chunkStart = 0; chunkStart < metadata.length; chunkStart += 10_000)
        {
            const chunkSize = Math.min(10_000, metadata.length - chunkStart);
            const vectorBytes = await embeddings.readRows(chunkStart, chunkSize);
            for (let offset = 0; offset < chunkSize; offset++)
            {
                const rowIndex = chunkStart + offset;
                const row = metadata[rowIndex];
                if (row.status !== 'success')
                    drops.status++;
                else if (row.NSFW !== 'UNLIKELY')
                    drops.nsfw++;
                else if (typeof row.url !== 'string' || !row.url.startsWith('https://'))
                    drops.url++;
                else if (typeof row.caption !== 'string' || !row.caption.trim())
                    drops.caption_empty++;
                else if (isNsfwText(row.caption))
                    drops.text_nsfw++;
                else
                {
                    const vector = normalizedHalfVector(vectorBytes, offset, embeddings.dimensions);
                    const unsafe = await clipUnsafe(vector);
                    if (unsafe >= 0.92)
                        drops.clip_unsafe++;
                    else
                    {
                        if (!batch.length)
                            batchStart = rowIndex;
                        batch.push({
                            id: shard * 2_000_000 + rowIndex,
                            shard,
                            url: row.url,
                            caption: row.caption,
                            similarity: Number(row.similarity),
                            width: Number(row.original_width),
                            height: Number(row.original_height),
                            license: row.LICENSE,
                            clip_unsafe: unsafe,
                            vector: Array.from(vector, (value) => Number(value.toFixed(6))),
                        });
                        if (batch.length >= batchSize)
                            await flush();
                    }
                }

                const scanned = rowIndex + 1;
                if (scanned - lastProgress >= 50_000)
                {
                    lastProgress = scanned;
                    log('progress', `shard=${shard}`, `scanned=${scanned}`, `inserted=${inserted}`, `dropped=${JSON.stringify(drops)}`);
                }
            }
        }
        await flush();
        done.add(String(shard));
        log('completed', `shard=${shard}`, `scanned=${metadata.length}`, `inserted=${inserted}`, `dropped=${JSON.stringify(drops)}`, `data_dir=${DATA_DIR}`);
    }
    finally
    {
        await embeddings.close();
    }
}

await ensureTable();
for (let shard = firstShard; shard <= lastShard; shard++)
    await loadShard(shard);
log('done');
