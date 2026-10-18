// Imports the yearly Stack Overflow posts Parquet files (ClickHouse public dataset) into a raw table, one server-side URL import per year.
// Usage: node datasets/stackoverflow/load.mjs [--from 2008] [--to 2024] [--table stackoverflow_posts]
import { insertFromUrl } from '../../lib/rawtree.mjs';
import { doneSet, log, options, retry } from '../../lib/loader.mjs';

const opts = options({ from: 2008, to: 2024, table: 'stackoverflow_posts' });
const done = doneSet(opts.table);

for (let year = Number(opts.from); year <= Number(opts.to); year++)
{
    const source = `https://datasets-documentation.s3.eu-west-3.amazonaws.com/stackoverflow/parquet/posts/${year}.parquet`;
    if (done.has(source))
        continue;
    const result = await retry(() => insertFromUrl(opts.table, source, { dedupToken: `stackoverflow-posts-${year}` }), String(year));
    log(year, JSON.stringify(result));
    done.add(source);
}
log('done');
