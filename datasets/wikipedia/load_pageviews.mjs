// Loads hourly Wikimedia pageview dumps (https://dumps.wikimedia.org/other/pageviews/) for the chosen wikis into a raw table.
// Each dump line is `domain_code page_title count_views total_response_size`; rows keep those fields plus the hour.
// Usage: node datasets/wikipedia/load_pageviews.mjs [--from 2023-10-25] [--days 7] [--wikis en,en.m] [--concurrency 3] [--table wikipedia_pageviews]
import readline from 'node:readline';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { insert } from '../../lib/rawtree.mjs';
import { doneSet, log, options, retry } from '../../lib/loader.mjs';

const opts = options({ from: '2023-10-25', days: 7, wikis: 'en,en.m', concurrency: 3, table: 'wikipedia_pageviews', batch: 100_000 });
const wikis = new Set(opts.wikis.split(','));
const done = doneSet(opts.table);
const BATCH = Number(opts.batch);

const pad = (n) => String(n).padStart(2, '0');
const hours = [];
for (let t = Date.parse(`${opts.from}T00:00:00Z`), end = t + Number(opts.days) * 86_400_000; t < end; t += 3_600_000)
    hours.push(new Date(t));

async function loadHour(date)
{
    const [y, m, d, h] = [date.getUTCFullYear(), pad(date.getUTCMonth() + 1), pad(date.getUTCDate()), pad(date.getUTCHours())];
    const file = `pageviews-${y}${m}${d}-${h}0000.gz`;
    const hour = `${y}-${m}-${d} ${h}:00:00`;
    const response = await fetch(`https://dumps.wikimedia.org/other/pageviews/${y}/${y}-${m}/${file}`, { headers: { 'user-agent': 'textsearch-poc (RawTree demo loader)' } });
    if (!response.ok)
        throw new Error(`${file}: HTTP ${response.status}`);
    const lines = readline.createInterface({ input: Readable.fromWeb(response.body).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    let batch = [], batchNo = 0, rows = 0;
    const flush = async () =>
    {
        await insert(opts.table, batch, { dedupToken: `${file}-${opts.wikis}-${batchNo++}` });
        rows += batch.length;
        batch = [];
    };
    for await (const line of lines)
    {
        const [domain_code, page_title, count_views, total_response_size] = line.split(' ');
        if (!wikis.has(domain_code) || page_title === undefined)
            continue;
        batch.push({ domain_code, page_title, count_views: Number(count_views), total_response_size: Number(total_response_size), hour });
        if (batch.length >= BATCH)
            await flush();
    }
    if (batch.length)
        await flush();
    return { file, rows };
}

const queue = hours.filter((date) => !done.has(date.toISOString()));
log(`${queue.length} of ${hours.length} hours to load`);
await Promise.all(Array.from({ length: Number(opts.concurrency) }, async () =>
{
    for (let date; (date = queue.shift());)
    {
        const { file, rows } = await retry(() => loadHour(date), date.toISOString());
        log(file, rows);
        done.add(date.toISOString());
    }
}));
log('done');
