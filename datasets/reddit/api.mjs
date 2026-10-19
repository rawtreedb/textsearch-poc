import { literal, query } from '../../lib/rawtree.mjs';
import { intParam, panel, parseSearch, snippet, sumValues, textCondition } from '../../lib/search.mjs';

const TABLE = 'reddit_comments_v2';
const BODY = 'lowerUTF8(body::String)';
const COMMENT_DATE = 'toDateTime(created_utc::Int64)';

function buildFilter(params)
{
    const { tokens, mode } = parseSearch(params);
    const conditions = [textCondition(BODY, tokens, mode)];
    const subreddit = (params.get('subreddit') ?? '').trim();
    if (subreddit && subreddit.length <= 80)
        conditions.push(`lowerUTF8(subreddit::String) = ${literal(subreddit.toLowerCase())}`);
    const author = (params.get('author') ?? '').trim();
    if (author && author.length <= 80)
        conditions.push(`lowerUTF8(author::String) = ${literal(author.toLowerCase())}`);
    const from = intParam(params, 'from', 2012, 2012, 2016);
    const to = intParam(params, 'to', 2016, 2012, 2016);
    if (from > 2012)
        conditions.push(`${COMMENT_DATE} >= toDateTime('${from}-01-01 00:00:00')`);
    if (to < 2016)
        conditions.push(`${COMMENT_DATE} < toDateTime('${to + 1}-01-01 00:00:00')`);
    return { tokens, where: conditions.join('\n  AND ') };
}

async function search(params)
{
    const { tokens, where } = buildFilter(params);
    const limit = intParam(params, 'limit', 20, 1, 100);
    const order = params.get('sort') === 'recent' ? `${COMMENT_DATE} DESC` : 'score::Int64 DESC';
    const hitsSql = `SELECT id::String AS id, link_id::String AS link_id, subreddit::String AS subreddit,
       author::String AS author, score::Int64 AS score, controversiality::Int64 AS controversiality,
       ${COMMENT_DATE} AS created, ${snippet('body::String', tokens)} AS snippet
FROM ${TABLE}
WHERE ${where}
ORDER BY ${order}
LIMIT ${limit}`;
    const timelineSql = `SELECT toStartOfMonth(${COMMENT_DATE}) AS bucket, 'comments' AS series, count() AS value
FROM ${TABLE}
WHERE ${where}
GROUP BY bucket, series
ORDER BY bucket`;
    const [hits, timeline] = await Promise.all([query(hitsSql), query(timelineSql)]);
    return {
        tokens,
        total: sumValues(timeline),
        hits: hits.data.map((row) =>
        {
            const parentId = String(row.link_id ?? '').replace(/^t3_/, '');
            return {
                title: `r/${row.subreddit ?? ''} · u/${row.author ?? ''}`,
                url: `https://www.reddit.com/r/${encodeURIComponent(row.subreddit ?? '')}/comments/${encodeURIComponent(parentId)}/_/${encodeURIComponent(row.id)}/`,
                snippet: row.snippet,
                meta: [`${row.score} score`, String(row.created).slice(0, 10), `${row.controversiality} controversiality`],
            };
        }),
        timeline: { title: 'Matching comments per month', kind: 'stack', result: timeline },
        queries: [{ title: 'Top Reddit comments', ...hits }],
    };
}

async function analytics(params)
{
    const { where } = buildFilter(params);
    const perMonthSql = `WITH top_subreddits AS (
    SELECT subreddit::String AS name FROM ${TABLE}
    WHERE ${where}
    GROUP BY name ORDER BY count() DESC LIMIT 5
)
SELECT toStartOfMonth(${COMMENT_DATE}) AS bucket,
       if(subreddit::String IN top_subreddits, subreddit::String, 'other') AS series,
       count() AS value
FROM ${TABLE}
WHERE ${where}
GROUP BY bucket, series
ORDER BY bucket, value DESC`;
    const subredditsSql = `SELECT subreddit::String AS label, count() AS value
FROM ${TABLE}
WHERE ${where}
GROUP BY label
ORDER BY value DESC
LIMIT 12`;
    const authorsSql = `SELECT author::String AS label, count() AS value
FROM ${TABLE}
WHERE ${where} AND author::String != '[deleted]'
GROUP BY label
ORDER BY value DESC
LIMIT 12`;
    const qualitySql = `SELECT round(avg(score::Int64), 2) AS average_score,
       quantile(0.5)(score::Int64) AS median_score, max(score::Int64) AS max_score,
       round(avg(controversiality::Int64), 4) AS average_controversiality,
       countIf(controversiality::Int64 > 0) AS controversial_comments
FROM ${TABLE}
WHERE ${where}`;
    const panels = await Promise.all([
        panel({ title: 'Matching comments per month by top subreddit', kind: 'stack', wide: true }, query(perMonthSql)),
        panel({ title: 'Top subreddits', kind: 'bars' }, query(subredditsSql)),
        panel({ title: 'Top authors', kind: 'bars' }, query(authorsSql)),
        panel({ title: 'Score and controversy statistics', kind: 'kv' }, query(qualitySql)),
    ]);
    return { panels };
}

async function stats()
{
    const result = await query(`SELECT count() AS comments FROM ${TABLE}`);
    return result.data[0];
}

export default {
    id: 'reddit',
    title: 'Reddit',
    description: 'Search historical Reddit comments by text, subreddit, author, year and score.',
    routes: { search, analytics, stats },
};
