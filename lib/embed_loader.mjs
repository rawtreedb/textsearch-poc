import fs, { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { DATA_DIR, doneSet, log, retry } from './loader.mjs';
import { DATABASE, createTable, describeTable, execute, insert, query, literal } from './rawtree.mjs';

const DIMENSIONS = 384;
const MAX_IN_FLIGHT_INSERTS = 2;

function positiveInteger(value, name, fallback)
{
    const number = Number(value ?? fallback);
    if (!Number.isInteger(number) || number < 1)
        throw new Error(`--${name} must be a positive integer`);
    return number;
}

function createWorkerPool(count, threads)
{
    const queue = [];
    const workers = [];
    let failure, closed = false;

    const fail = (error) =>
    {
        if (failure)
            return;
        failure = error;
        for (const task of queue.splice(0))
            task.reject(error);
        for (const worker of workers)
            worker.task?.reject(error);
    };
    const dispatch = () =>
    {
        if (failure || closed)
            return;
        for (const worker of workers)
        {
            if (worker.task || !queue.length)
                continue;
            worker.task = queue.shift();
            worker.child.send({ texts: worker.task.texts }, (error) =>
            {
                if (error)
                    fail(error);
            });
        }
    };
    const stopChildren = () => workers.forEach(({ child }) => child.kill());
    process.once('exit', stopChildren);

    for (let i = 0; i < count; i++)
    {
        const child = fork(fileURLToPath(new URL('./embed_worker.mjs', import.meta.url)), [String(threads)], {
            serialization: 'advanced',
            execArgv: [],
        });
        const worker = { child, task: null };
        child.on('message', ({ error, vectors }) =>
        {
            if (error)
                return fail(new Error(error));
            worker.task.resolve(vectors);
            worker.task = null;
            dispatch();
        });
        child.on('error', fail);
        child.on('exit', (code, signal) =>
        {
            if (!closed)
                fail(new Error(`Embedding child exited unexpectedly (${signal ?? code})`));
        });
        workers.push(worker);
    }

    return {
        run(texts)
        {
            if (failure || closed)
                return Promise.reject(failure ?? new Error('Embedding worker pool is closed'));
            const tasks = Array.from({ length: Math.ceil(texts.length / 32) }, (_, index) =>
                new Promise((resolve, reject) => queue.push({
                    texts: texts.slice(index * 32, index * 32 + 32), resolve, reject,
                })));
            dispatch();
            return Promise.all(tasks).then((vectors) => vectors.flat());
        },
        async close()
        {
            closed = true;
            process.off('exit', stopChildren);
            const exited = Promise.all(workers.map(({ child }) => new Promise((resolve) =>
            {
                if (child.exitCode !== null || child.signalCode !== null)
                    return resolve();
                child.once('exit', resolve);
                child.connected ? child.disconnect() : child.kill();
            })));
            const timeout = setTimeout(() => workers.forEach(({ child }) => child.kill('SIGKILL')), 5000);
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
            const url = typeof file.url === 'function' ? await file.url() : file.url;
            const response = await fetch(url, { signal });
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
    log('progress', `rows=${processed}`, `rows_per_second=${rate.toFixed(1)}`,
        `eta=${Math.round(Math.max(0, estimate - processed) / Math.max(rate, 1))}s`);
}

async function ensureTable(table, sortingKey)
{
    await createTable(table, sortingKey);
    const { table: info } = await describeTable(table);
    if (info.sorting_key.trim() !== sortingKey)
        throw new Error(`${table} has sorting key ${JSON.stringify(info.sorting_key)}, expected ${JSON.stringify(sortingKey)}; refusing to load`);
    const { data: indexes } = await query(`SELECT name FROM system.data_skipping_indices WHERE database = ${literal(DATABASE)} AND table = ${literal(table)}`);
    if (!indexes.some((index) => index.name === 'vector_idx'))
        await execute(`ALTER TABLE ${table} ADD INDEX vector_idx __raw_data.vector::Array(Float32) TYPE vector_similarity('hnsw', 'cosineDistance', ${DIMENSIONS})`);
}

export async function loadParquetEmbeddings(config)
{
    const { table, sortingKey, files, columns, isIncluded, textFor, recordFor, options, totalEstimate } = config;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table))
        throw new Error(`Invalid table name: ${table}`);
    const workers = positiveInteger(options.workers, 'workers', Math.max(1, Math.floor((os.availableParallelism() - 2) / 2)));
    const threads = positiveInteger(options.threads, 'threads', Number(process.env.ORT_INTRA_OP_NUM_THREADS) || 2);
    const batchSize = positiveInteger(options.batch, 'batch', 1000);
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 0)
        throw new Error('--limit must be a non-negative integer');

    const done = doneSet(table);
    const pool = createWorkerPool(workers, threads);
    const started = Date.now();
    const inserts = new Set();
    let processedRows = 0;
    let insertedRows = 0;
    let nextDownload;
    const destinationFor = (file) => path.join(DATA_DIR, `${table}-${file.key.replace(/[^A-Za-z0-9_.-]/g, '_')}.parquet`);
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
        while (inserts.size >= MAX_IN_FLIGHT_INSERTS)
            await Promise.race(inserts);
        const request = retry(() => insert(table, rows, { dedupToken: token }), token)
            .then(() =>
            {
                insertedRows += rows.length;
            })
            .finally(() => inserts.delete(request));
        inserts.add(request);
        return request;
    };

    try
    {
        await ensureTable(table, sortingKey);
        log('embedding', `table=${table}`, `workers=${workers}`, `threads=${threads}`, `batch=${batchSize}`);

        for (let fileIndex = 0; fileIndex < files.length; fileIndex++)
        {
            const source = files[fileIndex];
            const destination = destinationFor(source);
            const currentDownload = nextDownload ?? (fs.existsSync(destination) ? null : startDownload(source, destination));
            nextDownload = undefined;
            if (currentDownload)
            {
                const error = await currentDownload.promise;
                if (error)
                    throw error;
            }
            if (!limit && fileIndex + 1 < files.length)
            {
                const following = files[fileIndex + 1];
                const followingPath = destinationFor(following);
                if (!fs.existsSync(followingPath))
                    nextDownload = startDownload(following, followingPath);
            }

            log('downloaded', source.key, `${(fs.statSync(destination).size / 1e6).toFixed(1)} MB`);
            const file = await asyncBufferFromFile(destination);
            const groups = (await parquetMetadataAsync(file)).row_groups;
            let groupStart = 0;
            let limitReached = false;

            for (const [groupIndex, group] of groups.entries())
            {
                const groupEnd = groupStart + Number(group.num_rows);
                const unit = `${source.key}:${groupIndex}`;
                if (done.has(unit))
                {
                    log('skip completed row group', unit);
                    groupStart = groupEnd;
                    continue;
                }

                let readStart = groupStart;
                let batch = [];
                let batchNo = 0;
                const jobs = new Set();
                const schedule = async (items) =>
                {
                    const token = `${table}-${source.key}-${groupIndex}-${batchNo++}`;
                    const job = pool.run(items.map(textFor)).then(async (vectors) =>
                    {
                        const rows = items.map((row, index) => recordFor(row,
                            Array.from(vectors[index], (value) => Number(value.toFixed(6)))));
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
                            limitReached = true;
                            break;
                        }
                        batch.push(row);
                        processedRows++;
                        if (batch.length === batchSize)
                        {
                            const items = batch;
                            batch = [];
                            await schedule(items);
                        }
                    }
                    if (limitReached)
                        break;
                }
                if (batch.length)
                    await schedule(batch);
                await Promise.all(jobs);
                if (!limitReached)
                    done.add(unit);
                displayProgress(processedRows, limit ? Math.min(limit, totalEstimate) : totalEstimate, started);
                groupStart = groupEnd;
                if (limitReached)
                    break;
            }
            await fs.promises.rm(destination, { force: true });
            if (limitReached)
                break;
        }
    }
    finally
    {
        if (nextDownload)
        {
            nextDownload.abort();
            await nextDownload.promise;
        }
        let closeError;
        try
        {
            await pool.close();
        }
        catch (error)
        {
            closeError = error;
        }
        await Promise.all(inserts);
        if (closeError)
            throw closeError;
    }
    log('done', `rows=${processedRows}`, `inserted=${insertedRows}`);
}
