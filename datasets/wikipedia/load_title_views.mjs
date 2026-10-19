// Builds `wikipedia_title_views` (one row per page title: desktop, mobile and total views over all loaded hours) from `wikipedia_pageviews`,
// one INSERT ... SELECT per page-title range so each statement stays under the 30 s query limit.
// Ranges are cut from the pageviews primary index marks (about --rows source rows each); a range that already has rows is skipped, so re-runs resume.
// Usage: node datasets/wikipedia/load_title_views.mjs [--rows 8000000] [--source wikipedia_pageviews] [--table wikipedia_title_views]
import { DATABASE, createTable, execute, literal, query } from '../../lib/rawtree.mjs';
import { log, options, retry } from '../../lib/loader.mjs';

const opts = options({ rows: 8_000_000, source: 'wikipedia_pageviews', table: 'wikipedia_title_views' });

const { data: marks } = await query(`SELECT toString(__raw_data.page_title) AS title, sum(rows_in_granule) AS rows
FROM mergeTreeIndex(${literal(DATABASE)}, ${literal(opts.source)})
GROUP BY title
ORDER BY title`);
const bounds = [];
for (let i = 0, rows = 0; i < marks.length; i++)
{
    rows += Number(marks[i].rows);
    if (rows >= Number(opts.rows) && i + 1 < marks.length)
    {
        bounds.push(marks[i + 1].title);
        rows = 0;
    }
}
const ranges = [null, ...bounds].map((from, i) => [from, bounds[i] ?? null]);

await createTable(opts.table, 'page_title');
for (const [from, to] of ranges)
{
    const label = `[${from ?? ''}, ${to ?? ''})`;
    const range = (title) => [from !== null && `${title} >= ${literal(from)}`, to !== null && `${title} < ${literal(to)}`].filter(Boolean).join(' AND ') || '1';
    await retry(async () =>
    {
        // An INSERT whose response timed out may still have committed. The `__raw_data.` prefix also works while the table is still empty.
        const { data } = await query(`SELECT count() AS rows FROM ${opts.table} WHERE ${range('__raw_data.page_title::String')}`);
        if (Number(data[0].rows) > 0)
            return log(label, 'exists');
        const result = await execute(`INSERT INTO ${opts.table}
SELECT page_title::String AS page_title,
       sumIf(count_views::Int64, domain_code::String = 'en') AS desktop,
       sumIf(count_views::Int64, domain_code::String = 'en.m') AS mobile,
       sum(count_views::Int64) AS total
FROM ${opts.source}
WHERE domain_code::String IN ('en', 'en.m') AND ${range('page_title::String')}
GROUP BY page_title`);
        log(label, JSON.stringify(result.statistics));
    }, label);
}
log('done', ranges.length, 'ranges');
