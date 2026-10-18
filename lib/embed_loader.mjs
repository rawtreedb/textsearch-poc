import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { DATA_DIR, doneSet, log, retry } from './loader.mjs';
import { createTable, describeTable, execute, insert, listTables, query, literal } from './rawtree.mjs';

const DIMENSIONS = 384;
const MAX_IN_FLIGHT_INSERTS = 2;

function positiveInteger(value, name, fallback)
{
    const number = Number(value ?? fallback);
    if (!Number.isInteger(number) || number < 1)
        throw new Error(`--${name} must be a positive integer`);
    return number;
}

function createWorkerPool(workers, threads)
{
    const queue = [];
    const pool = [];
    let nextId = 0;
    let failure;
    let closed = false;
    let resolveReady;
    let rejectReady;
    let readyCount = 0;
    const ready = new Promise((resolve, reject) =>
    {
        resolveReady = resolve;
        rejectReady = reject;
    });

    const stopChildren = () =>
    {
        for (const worker of pool)
            worker.child.kill();
    };
    process.on('exit', stopChildren);
    process.on('uncaughtExceptionMonitor', stopChildren);

    const fail = (error) =>
    {
        if (failure)
            return;
        failure = error;
        rejectReady(error);
        while (queue.length)
            queue.shift().reject(error);
        for (const worker of pool)
        {
            if (worker.task)
            {
                worker.task.reject(error);
                worker.task = null;
                worker.busy = false;
            }
        }
    };

    const dispatch = () =>
    {
        if (failure || closed)
            return;
        for (const worker of pool)
        {
            if (worker.busy || !queue.length)
                continue;
            const task = queue.shift();
            worker.busy = true;
            worker.task = task;
            try
            {
                worker.child.send({ id: task.id, texts: task.texts }, (error) =>
                {
                    if (error)
                        fail(error);
                });
            }
            catch (error)
            {
                fail(error);
            }
        }
    };

    for (let index = 0; index < workers; index++)
    {
        const child = fork(fileURLToPath(new URL('./embed_worker.mjs', import.meta.url)), [], {
            serialization: 'advanced',
            execArgv: [],
            env: { ...process.env, ORT_INTRA_OP_NUM_THREADS: String(threads) },
        });
        const worker = { child, busy: false, task: null };
        child.on('message', (message) =>
        {
            if (message.ready)
            {
                if (++readyCount === workers)
                    resolveReady();
                return;
            }
            const task = worker.task;
            if (!task || task.id !== message.id)
            {
                fail(new Error(`Embedding child returned unexpected task ${message.id}`));
                return;
            }
            worker.task = null;
            worker.busy = false;
            if (message.error)
                task.reject(Object.assign(new Error(message.error), { stack: message.stack }));
            else if (!Array.isArray(message.vectors) || message.vectors.some((vector) => !(vector instanceof Float32Array)))
                task.reject(new Error('Embedding child returned non-Float32Array vectors'));
            else
                task.resolve(message.vectors);
            dispatch();
        });
        child.on('error', (error) =>
        {
            if (!closed)
                fail(new Error(`Embedding child failed: ${error.message}`, { cause: error }));
        });
        child.on('exit', (code, signal) =>
        {
            if (!closed)
                fail(new Error(`Embedding child exited unexpectedly (${signal ?? code})`));
        });
        pool.push(worker);
    }

    return {
        ready,
        run(texts)
        {
            if (failure)
                return Promise.reject(failure);
            if (closed)
                return Promise.reject(new Error('Embedding worker pool is closed'));
            const chunks = [];
            for (let offset = 0; offset < texts.length; offset += 32)
                chunks.push(texts.slice(offset, offset + 32));
            const embedded = chunks.map((chunk) => new Promise((resolve, reject) =>
            {
                queue.push({ id: nextId++, texts: chunk, resolve, reject });
                dispatch();
            }));
            return Promise.all(embedded).then((vectors) => vectors.flat());
        },
        async close()
        {
            if (closed)
                return;
            closed = true;
            process.off('exit', stopChildren);
            process.off('uncaughtExceptionMonitor', stopChildren);
            const exited = Promise.all(pool.map((worker) => new Promise((resolve) =>
            {
                if (worker.child.exitCode !== null || worker.child.signalCode !== null)
                    return resolve();
                worker.child.once('exit', resolve);
                if (worker.child.connected)
                    worker.child.disconnect();
                else
                    worker.child.kill();
            })));
            const timeout = setTimeout(() => pool.forEach((worker) => worker.child.kill('SIGKILL')), 5000);
            await exited;
            clearTimeout(timeout);
            if (failure)
                throw failure;
        },
    };
}

async function download(file, destination, signal)
{
    await retry(async () =>
    {
        const partial = `${destination}.partial`;
        try
        {
            const response = await fetch(file.url, { signal });
            if (!response.ok)
                throw new Error(`${file.key}: download HTTP ${response.status}`);
            if (!response.body)
                throw new Error(`${file.key}: empty download response`);
            await streamPipeline(response.body, createWriteStream(partial));
            await fs.promises.rename(partial, destination);
        }
        catch (error)
        {
            await fs.promises.rm(partial, { force: true });
            throw error;
        }
    }, file.key);
}

function displayProgress(processed, estimate, started)
{
    const elapsed = (Date.now() - started) / 1000;
    const rate = processed / Math.max(elapsed, 1);
    const remaining = Math.max(0, estimate - processed);
    log('progress', `rows=${processed}`, `rows_per_second=${rate.toFixed(1)}`, `eta=${Math.round(remaining / Math.max(rate, 1))}s`);
}

async function ensureTable(table, sortingKey)
{
    const { tables } = await listTables();
    if (!tables.some((entry) => entry.name === table))
        await createTable(table, sortingKey);
    const { table: info } = await describeTable(table);
    if (info.sorting_key.trim() !== sortingKey)
        throw new Error(`${table} has sorting key ${JSON.stringify(info.sorting_key)}, expected ${JSON.stringify(sortingKey)}; refusing to load`);

    const { data: indexes } = await query(`SELECT name FROM system.data_skipping_indices WHERE database = ${literal(process.env.RAWTREE_DATABASE ?? 'default')} AND table = ${literal(table)}`);
    if (!indexes.some((index) => index.name === 'vector_idx'))
        await execute(`ALTER TABLE ${table} ADD INDEX vector_idx __raw_data.vector::Array(Float32) TYPE vector_similarity('hnsw', 'cosineDistance', ${DIMENSIONS})`);
}

export async function loadParquetEmbeddings({
    table,
    sortingKey,
    files,
    columns,
    countColumns,
    isIncluded,
    textFor,
    recordFor,
    options,
    totalEstimate,
})
{
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table))
        throw new Error(`Invalid table name: ${table}`);
    const workers = positiveInteger(options.workers, 'workers', Math.max(1, Math.floor((os.availableParallelism() - 2) / 2)));
    const threads = positiveInteger(options.threads, 'threads', 2);
    const batchSize = positiveInteger(options.batch, 'batch', 1000);
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 0)
        throw new Error('--limit must be a non-negative integer');

    const done = doneSet(table);
    const pool = createWorkerPool(workers, threads);
    const startTime = Date.now();
    let processedRows = 0;
    let insertedRows = 0;
    let inflightInserts = new Set();
    let nextDownload;

    const startDownload = (file, destination) =>
    {
        const controller = new AbortController();
        return {
            abort: () => controller.abort(),
            promise: download(file, destination, controller.signal).then(() => null, (error) => error),
        };
    };

    const insertBatch = async (rows, token) =>
    {
        while (inflightInserts.size >= MAX_IN_FLIGHT_INSERTS)
            await Promise.race(inflightInserts);
        const request = retry(() => insert(table, rows, { dedupToken: token }), token)
            .then(() => { insertedRows += rows.length; })
            .finally(() => inflightInserts.delete(request));
        inflightInserts.add(request);
        return request;
    };

    try
    {
        await pool.ready;
        await ensureTable(table, sortingKey);
        log('embedding', `table=${table}`, `workers=${workers}`, `threads=${threads}`, `batch=${batchSize}`);

        for (let fileIndex = 0; fileIndex < files.length; fileIndex++)
        {
            const source = files[fileIndex];
            if (nextDownload)
            {
                const download = nextDownload;
                nextDownload = undefined;
                const error = await download.promise;
                if (error)
                    throw error;
            }
            const destination = path.join(DATA_DIR, `${table}-${source.key.replace(/[^A-Za-z0-9_.-]/g, '_')}.parquet`);
            const pendingFile = fs.existsSync(destination) ? Promise.resolve(null) : startDownload(source, destination).promise;
            if (fileIndex + 1 < files.length && !limit)
            {
                const following = files[fileIndex + 1];
                const followingPath = path.join(DATA_DIR, `${table}-${following.key.replace(/[^A-Za-z0-9_.-]/g, '_')}.parquet`);
                if (!fs.existsSync(followingPath))
                    nextDownload = startDownload(following, followingPath);
            }
            const downloadError = await pendingFile;
            if (downloadError)
                throw downloadError;
            log('downloaded', source.key, `${(fs.statSync(destination).size / 1e6).toFixed(1)} MB`);
            const file = await asyncBufferFromFile(destination);
            const metadata = await parquetMetadataAsync(file);
            let rowStart = 0;
            let limitReached = false;
            const rowGroups = metadata.row_groups;
            for (let groupIndex = 0; groupIndex < rowGroups.length; groupIndex++)
            {
                const group = rowGroups[groupIndex];
                const groupRows = Number(group.num_rows);
                const groupStart = rowStart;
                const groupEnd = groupStart + groupRows;
                rowStart = groupEnd;
                const unit = `${source.key}:${groupIndex}`;
                if (done.has(unit))
                {
                    log('skip completed row group', unit);
                    if (limit)
                    {
                        if (countColumns)
                        {
                            const rows = await parquetReadObjects({ file, columns: countColumns, rowStart: groupStart, rowEnd: groupEnd, compressors });
                            processedRows += rows.filter(isIncluded).length;
                        }
                        else
                            processedRows += groupRows;
                        if (processedRows >= limit)
                        {
                            limitReached = true;
                            displayProgress(processedRows, Math.min(limit, totalEstimate), startTime);
                            break;
                        }
                    }
                    continue;
                }

                let batch = [];
                let batchNo = 0;
                let readStart = groupStart;
                let fullyReadGroup = true;
                const jobs = new Set();
                const schedule = async (items) =>
                {
                    const texts = items.map((row) => textFor(row));
                    const token = `${table}-${source.key}-${groupIndex}-${batchNo++}`;
                    const job = pool.run(texts)
                        .then(async (vectors) =>
                        {
                            const rows = items.map((row, index) =>
                            {
                                const vector = vectors[index];
                                return recordFor(row, Array.from(vector, (value) => Number(value.toFixed(6))));
                            });
                            await insertBatch(rows, token);
                        });
                    jobs.add(job);
                    job.then(() => jobs.delete(job), () => jobs.delete(job));
                    if (jobs.size >= workers * 2)
                        await Promise.race(jobs);
                };

                while (readStart < groupEnd)
                {
                    if (limit && processedRows >= limit)
                    {
                        fullyReadGroup = false;
                        limitReached = true;
                        break;
                    }
                    const chunkEnd = Math.min(groupEnd, readStart + Math.max(batchSize, 1000));
                    const rows = await parquetReadObjects({ file, columns, rowStart: readStart, rowEnd: chunkEnd, compressors });
                    readStart = chunkEnd;
                    for (const row of rows)
                    {
                        if (!isIncluded(row))
                            continue;
                        if (limit && processedRows >= limit)
                        {
                            fullyReadGroup = false;
                            limitReached = true;
                            break;
                        }
                        batch.push(row);
                        processedRows++;
                        if (batch.length >= batchSize)
                        {
                            const ready = batch;
                            batch = [];
                            await schedule(ready);
                        }
                    }
                    if (limitReached)
                    {
                        fullyReadGroup = false;
                        break;
                    }
                }
                if (batch.length)
                    await schedule(batch);
                await Promise.all(jobs);
                await Promise.all(inflightInserts);
                if (fullyReadGroup)
                    done.add(unit);
                displayProgress(processedRows, limit ? Math.min(limit, totalEstimate) : totalEstimate, startTime);
                if (limitReached)
                    break;
            }
            await fs.promises.rm(destination, { force: true });
            if (limitReached)
                break;
        }
        await Promise.all(inflightInserts);
    }
    finally
    {
        if (nextDownload)
        {
            nextDownload.abort();
            await nextDownload.promise;
        }
        let closeError;
        try { await pool.close(); }
        catch (error) { closeError = error; }
        await Promise.all(inflightInserts);
        if (closeError)
            throw closeError;
    }
    log('done', `rows=${processedRows}`, `inserted=${insertedRows}`);
}
