import { literal, query } from '../../lib/rawtree.mjs';
import { intParam, panel, parseSearch, snippet, sumValues, textCondition } from '../../lib/search.mjs';

const TABLE = 'hackernews_items';
const TITLE = 'lowerUTF8(title::String)';
const TEXT = 'lowerUTF8(text::String)';
const PLAIN_TEXT = `replaceRegexpAll(replaceRegexpAll(text::String, '<[^>]*>', ' '), '\\\\s+', ' ')`;
const AUTHOR = '`by`::String';
const ITEM_DATE = 'toDateTime(time::UInt32)';
const FIELDS = ['both', 'title', 'text'];
const TYPES = { all: '1', stories: 'type::Int64 = 1', comments: 'type::Int64 = 2' };

function buildFilter(params)
{
    const { tokens, mode } = parseSearch(params);
    const field = FIELDS.includes(params.get('field')) ? params.get('field') : 'both';
    const type = TYPES[params.get('type')] ? params.get('type') : 'all';
    const conditions = ['deleted::UInt8 = 0', 'dead::UInt8 = 0', TYPES[type]];
    conditions.push({
        both: `(${textCondition(TITLE, tokens, mode)} OR ${textCondition(TEXT, tokens, mode)})`,
        title: textCondition(TITLE, tokens, mode),
        text: textCondition(TEXT, tokens, mode),
    }[field]);
    const author = (params.get('author') ?? '').trim();
    if (author && author.length <= 80)
        conditions.push(`lowerUTF8(${AUTHOR}) = ${literal(author.toLowerCase())}`);
    const from = intParam(params, 'from', 2006, 2006, 2023);
    const to = intParam(params, 'to', 2023, 2006, 2023);
    if (from > 2006)
        conditions.push(`${ITEM_DATE} >= toDateTime('${from}-01-01 00:00:00')`);
    if (to < 2023)
        conditions.push(`${ITEM_DATE} < toDateTime('${to + 1}-01-01 00:00:00')`);
    return { tokens, where: conditions.join('\n  AND ') };
}

async function search(params)
{
    const { tokens, where } = buildFilter(params);
    const limit = intParam(params, 'limit', 20, 1, 100);
    const order = params.get('sort') === 'recent' ? `${ITEM_DATE} DESC` : 'score::Int64 DESC';
    const hitsSql = `SELECT id::Int64 AS id, type::Int64 AS type, ${AUTHOR} AS author,
       title::String AS title, ${snippet(PLAIN_TEXT, tokens)} AS snippet,
       score::Int64 AS score, ${ITEM_DATE} AS created
FROM ${TABLE}
WHERE ${where}
ORDER BY ${order}
LIMIT ${limit}`;
    const timelineSql = `SELECT toStartOfMonth(${ITEM_DATE}) AS bucket,
       if(type::Int64 = 1, 'stories', if(type::Int64 = 2, 'comments', 'other')) AS series,
       count() AS value
FROM ${TABLE}
WHERE ${where}
GROUP BY bucket, series
ORDER BY bucket, series`;
    const [hits, timeline] = await Promise.all([query(hitsSql), query(timelineSql)]);
    return {
        tokens,
        total: sumValues(timeline),
        hits: hits.data.map((row) => ({
            title: row.type === 2 ? `Comment by ${row.author || '[deleted]'}` : (row.title || `Hacker News item by ${row.author || '[deleted]'}`),
            url: `https://news.ycombinator.com/item?id=${row.id}`,
            snippet: row.snippet || row.title || '',
            meta: [`${row.score} points`, String(row.created).slice(0, 10), row.author, row.type === 1 ? 'story' : row.type === 2 ? 'comment' : 'other'],
        })),
        timeline: { title: 'Matching items per month by type', kind: 'stack', result: timeline },
        queries: [{ title: 'Top Hacker News items', ...hits }],
    };
}

async function analytics(params)
{
    const { where } = buildFilter(params);
    const perMonthSql = `SELECT toStartOfMonth(${ITEM_DATE}) AS bucket,
       if(type::Int64 = 1, 'stories', if(type::Int64 = 2, 'comments', 'other')) AS series,
       count() AS value
FROM ${TABLE}
WHERE ${where}
GROUP BY bucket, series
ORDER BY bucket, series`;
    const authorsSql = `SELECT ${AUTHOR} AS label, count() AS value
FROM ${TABLE}
WHERE ${where} AND ${AUTHOR} != ''
GROUP BY label
ORDER BY value DESC
LIMIT 12`;
    const domainsSql = `SELECT domain(url::String) AS label, count() AS value
FROM ${TABLE}
WHERE ${where} AND type::Int64 = 1 AND url::String != ''
GROUP BY label
ORDER BY value DESC
LIMIT 12`;
    const scoreSql = `SELECT round(avg(score::Int64), 2) AS average_score,
       quantile(0.5)(score::Int64) AS median_score, max(score::Int64) AS max_score,
       countIf(score::Int64 > 0) AS positive_score_items
FROM ${TABLE}
WHERE ${where}`;
    const panels = await Promise.all([
        panel({ title: 'Matching items per month by type', kind: 'stack', wide: true }, query(perMonthSql)),
        panel({ title: 'Top authors', kind: 'bars' }, query(authorsSql)),
        panel({ title: 'Top story domains', kind: 'bars' }, query(domainsSql)),
        panel({ title: 'Score statistics', kind: 'kv' }, query(scoreSql)),
    ]);
    return { panels };
}

async function stats()
{
    const result = await query(`SELECT count() AS items,
       countIf(type::Int64 = 1) AS stories, countIf(type::Int64 = 2) AS comments,
       min(${ITEM_DATE}) AS first_item, max(${ITEM_DATE}) AS last_item
FROM ${TABLE}
WHERE deleted::UInt8 = 0 AND dead::UInt8 = 0
  AND ${ITEM_DATE} >= toDateTime('2006-01-01 00:00:00')
  AND ${ITEM_DATE} < toDateTime('2024-01-01 00:00:00')`);
    return result.data[0];
}

export default {
    id: 'hackernews',
    title: 'Hacker News',
    description: 'Full-text search over Hacker News stories and comments with author, date and score analytics.',
    routes: { search, analytics, stats },
};
