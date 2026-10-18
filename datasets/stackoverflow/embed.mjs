import os from 'node:os';
import { loadParquetEmbeddings } from '../../lib/embed_loader.mjs';
import { options } from '../../lib/loader.mjs';

const opts = options({
    from: 2008,
    to: 2024,
    table: 'stackoverflow_vectors',
    files: 0,
    limit: 0,
    workers: Math.max(1, Math.floor((os.availableParallelism() - 2) / 2)),
    threads: Number(process.env.ORT_INTRA_OP_NUM_THREADS) || 2,
    batch: 1000,
});
const firstYear = Number(opts.from);
const lastYear = Number(opts.to);
if (!Number.isInteger(firstYear) || !Number.isInteger(lastYear) || firstYear < 2008 || lastYear > 2024 || firstYear > lastYear)
    throw new Error('Stack Overflow years must be between 2008 and 2024 with --from <= --to');
const fileLimit = Number(opts.files);
if (!Number.isInteger(fileLimit) || fileLimit < 0)
    throw new Error('--files must be a non-negative integer');

const files = [];
for (let year = firstYear; year <= lastYear; year++)
{
    const key = String(year);
    files.push({
        key,
        url: `https://datasets-documentation.s3.eu-west-3.amazonaws.com/stackoverflow/parquet/posts/${key}.parquet`,
    });
}
if (fileLimit > 0)
    files.splice(fileLimit);

const dateTime = (value) =>
{
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime()))
        throw new Error(`Invalid Stack Overflow CreationDate: ${value}`);
    return `${date.toISOString().slice(0, 23).replace('T', ' ')}`;
};

const plainBody = (body) => String(body ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

await loadParquetEmbeddings({
    table: opts.table,
    sortingKey: 'Id',
    files,
    columns: ['Id', 'PostTypeId', 'Title', 'Body', 'Tags', 'Score', 'ViewCount', 'AnswerCount', 'CreationDate'],
    countColumns: ['PostTypeId'],
    isIncluded: (row) => Number(row.PostTypeId) === 1,
    textFor: (row) => `${row.Title ?? ''}\n${plainBody(row.Body)}`,
    recordFor: (row, vector) => ({
        Id: Number(row.Id),
        Title: row.Title,
        Tags: row.Tags ?? '',
        Score: Number(row.Score ?? 0),
        ViewCount: Number(row.ViewCount ?? 0),
        AnswerCount: Number(row.AnswerCount ?? 0),
        CreationDate: dateTime(row.CreationDate),
        vector,
    }),
    options: opts,
    totalEstimate: 21_000_000,
});
