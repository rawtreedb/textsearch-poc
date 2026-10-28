// Search, analytics and stats for Wikipedia articles (`wikipedia_articles`) joined with hourly pageviews (`wikipedia_pageviews`).
// Matches are ranked by per-title totals (`wikipedia_title_views`); hourly charts read pageviews only for the top-ranked titles,
// because a common term matches tens of thousands of titles, which makes the pageviews scan cost most of the table.
import { literal, query } from '../../lib/rawtree.mjs';
import { intParam, panel, parseSearch, snippet, textCondition } from '../../lib/search.mjs';

const ARTICLES = 'wikipedia_articles';
const PAGEVIEWS = 'wikipedia_pageviews';
const TITLE_VIEWS = 'wikipedia_title_views';
const CHART_TITLES = 20;
const TITLE = 'lowerUTF8(title::String)';
const TEXT = 'lowerUTF8(text::String)';
const FIELDS = ['text', 'title', 'both'];
// Desktop and mobile web views of the English Wikipedia; pageview titles use underscores instead of spaces.
const WIKIS = `domain_code::String IN ('en', 'en.m')`;
const PAGE_TITLE = `page_title::String`;
const ARTICLE_PAGE_TITLE = `replaceAll(title::String, ' ', '_')`;

function buildFilter(params)
{
    const { tokens, mode } = parseSearch(params);
    const field = FIELDS.includes(params.get('field')) ? params.get('field') : 'text';
    const conditions = {
        text: textCondition(TEXT, tokens, mode),
        title: textCondition(TITLE, tokens, mode),
        both: `(${textCondition(TITLE, tokens, mode)} OR ${textCondition(TEXT, tokens, mode)})`,
    };
    const where = conditions[field];
    const matches = `matches AS (SELECT ${ARTICLE_PAGE_TITLE} FROM ${ARTICLES} WHERE ${where})`;
    return { tokens, mode, field, where, matches };
}

const titleList = (titles) => titles.length ? titles.map(literal).join(', ') : "''";

const topTitlesSql = (matches, limit) => `WITH ${matches}
SELECT ${PAGE_TITLE} AS page_title, total::Int64 AS views
FROM ${TITLE_VIEWS}
WHERE ${PAGE_TITLE} IN matches
ORDER BY views DESC
LIMIT ${limit}`;

const hourlySql = (titles) => `SELECT hour::DateTime AS bucket, if(domain_code::String = 'en', 'desktop', 'mobile') AS series, sum(count_views::Int64) AS value
FROM ${PAGEVIEWS}
WHERE ${WIKIS} AND ${PAGE_TITLE} IN (${titleList(titles)})
GROUP BY bucket, series
ORDER BY bucket, series`;

async function search(params)
{
    const { tokens, where, matches } = buildFilter(params);
    const limit = intParam(params, 'limit', 20, 1, 100);
    const countSql = `SELECT count() AS matches
FROM ${ARTICLES}
WHERE ${where}`;
    const [count, top] = await Promise.all([query(countSql), query(topTitlesSql(matches, limit))]);

    // Snippets for the most viewed articles; if the pageviews table has no match yet, fall back to arbitrary matching articles.
    const titles = top.data.map((row) => row.page_title.replaceAll('_', ' '));
    const chartTitles = top.data.slice(0, CHART_TITLES).map((row) => row.page_title);
    const hitsSql = `SELECT title::String AS title, url::String AS url,
       length(text::String) AS bytes,
       ${snippet('text::String', tokens)} AS snippet
FROM ${ARTICLES}
WHERE ${titles.length ? `title::String IN (${titles.map(literal).join(', ')})` : where}
LIMIT ${limit}`;
    const [hits, timeline] = await Promise.all([
        query(hitsSql),
        chartTitles.length ? query(hourlySql(chartTitles)) : Promise.resolve({ data: [], sql: '' }),
    ]);
    const views = new Map(top.data.map((row) => [row.page_title.replaceAll('_', ' '), Number(row.views)]));
    const rows = hits.data
        .map((row) => ({ ...row, views: views.get(row.title) ?? 0 }))
        .sort((a, b) => b.views - a.views)
        .map((row) => ({
            title: row.title,
            url: row.url,
            snippet: row.snippet,
            meta: [`${row.views.toLocaleString('en-US')} views`, `${(Number(row.bytes) / 1024).toFixed(1)} KB`],
        }));
    return {
        tokens,
        total: Number(count.data[0]?.matches ?? 0),
        hits: rows,
        timeline: { title: `Hourly pageviews of the ${chartTitles.length} most viewed matches`, kind: 'stack', result: timeline },
        queries: [{ title: 'Matching articles', ...count }, { title: 'Most viewed matches', ...top }, { title: 'Snippets', ...hits }, { title: 'Hourly pageviews', ...timeline }],
    };
}

async function analytics(params)
{
    const { where, matches } = buildFilter(params);
    // On failure only the pageview panels come back empty; the article panels still run.
    const top = await query(topTitlesSql(matches, CHART_TITLES)).catch(() => ({ data: [] }));
    const titles = top.data.map((row) => row.page_title);
    const topArticlesSql = `SELECT toStartOfInterval(hour::DateTime, INTERVAL 6 HOUR) AS bucket,
       replaceAll(if(${PAGE_TITLE} IN (${titleList(titles.slice(0, 6))}), ${PAGE_TITLE}, 'other'), '_', ' ') AS series,
       sum(count_views::Int64) AS value
FROM ${PAGEVIEWS}
WHERE ${WIKIS} AND ${PAGE_TITLE} IN (${titleList(titles)})
GROUP BY bucket, series
ORDER BY bucket, value DESC`;
    // Busiest hour over the charted titles; totals over all matches.
    const peakSql = `WITH ${matches}
SELECT busiest_hour, busiest_hour_views, total_views, mobile_percent
FROM
(
    SELECT argMax(hour, views) AS busiest_hour, max(views) AS busiest_hour_views
    FROM
    (
        SELECT hour::DateTime AS hour, sum(count_views::Int64) AS views
        FROM ${PAGEVIEWS}
        WHERE ${WIKIS} AND ${PAGE_TITLE} IN (${titleList(titles)})
        GROUP BY hour
    )
) AS peak
CROSS JOIN
(
    SELECT sum(total::Int64) AS total_views, round(sum(mobile::Int64) / sum(total::Int64) * 100, 1) AS mobile_percent
    FROM ${TITLE_VIEWS}
    WHERE ${PAGE_TITLE} IN matches
) AS totals`;
    const lengthSql = `SELECT multiIf(b < 2048, '< 2 KB', b < 8192, '2-8 KB', b < 32768, '8-32 KB', b < 131072, '32-128 KB', '>= 128 KB') AS label, count() AS value, min(b) AS min_bytes
FROM (SELECT length(text::String) AS b FROM ${ARTICLES} WHERE ${where})
GROUP BY label
ORDER BY min_bytes`;
    const longestSql = `SELECT title::String AS label, round(length(text::String) / 1024) AS value
FROM ${ARTICLES}
WHERE ${where}
ORDER BY value DESC
LIMIT 10`;
    const panels = await Promise.all([
        panel({ title: `Pageviews of the ${titles.length} most viewed matches (6-hour buckets, top 6 named)`, kind: 'stack', wide: true }, query(topArticlesSql)),
        panel({ title: `Peak hour (${titles.length} most viewed matches) and totals (all matches)`, kind: 'kv' }, query(peakSql)),
        panel({ title: 'Matching articles by length', kind: 'bars' }, query(lengthSql)),
        panel({ title: 'Longest matching articles (KB)', kind: 'bars' }, query(longestSql)),
    ]);
    return { panels };
}

async function stats()
{
    const [articles, pageviews] = await Promise.all([
        query(`SELECT count() AS articles, sum(length(text::String)) AS text_bytes FROM ${ARTICLES}`),
        query(`SELECT count() AS rows, min(hour::DateTime) AS first_hour, max(hour::DateTime) AS last_hour FROM ${PAGEVIEWS}`).catch(() => ({ data: [{}] })),
    ]);
    return { ...articles.data[0], pageview_rows: pageviews.data[0].rows, first_hour: pageviews.data[0].first_hour, last_hour: pageviews.data[0].last_hour };
}

export default {
    id: 'wikipedia',
    title: 'Wikipedia',
    description: 'Full-text search over English Wikipedia articles, ranked and charted by hourly pageviews.',
    routes: { search, analytics, stats },
};
