// Search, analytics and stats for Wikipedia articles (`wikipedia_articles`) joined with hourly pageviews (`wikipedia_pageviews`).
import { semanticQuery } from '../../lib/text_embed.mjs';
import { literal, query } from '../../lib/rawtree.mjs';
import { intParam, panel, parseSearch, snippet, textCondition } from '../../lib/search.mjs';

const ARTICLES = 'wikipedia_articles';
const PAGEVIEWS = 'wikipedia_pageviews';
const TITLE = 'lowerUTF8(title::String)';
const TEXT = 'lowerUTF8(text::String)';
const FIELDS = ['text', 'title', 'both'];
// Desktop and mobile web views of the English Wikipedia; pageview titles use underscores instead of spaces.
const WIKIS = `domain_code::String IN ('en', 'en.m')`;
const PAGE_TITLE = `page_title::String`;
const ARTICLE_PAGE_TITLE = `replaceAll(title::String, ' ', '_')`;
const VECTORS = 'wikipedia_vectors';

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

async function search(params)
{
    if (params.get('mode') === 'semantic')
        return semanticSearch(params);

    const { tokens, where, matches } = buildFilter(params);
    const limit = intParam(params, 'limit', 20, 1, 100);
    const countSql = `SELECT count() AS matches
FROM ${ARTICLES}
WHERE ${where}`;
    const topSql = `WITH ${matches}
SELECT ${PAGE_TITLE} AS page_title, sum(count_views::Int64) AS views
FROM ${PAGEVIEWS}
WHERE ${WIKIS} AND ${PAGE_TITLE} IN matches
GROUP BY page_title
ORDER BY views DESC
LIMIT ${limit}`;
    const timelineSql = `WITH ${matches}
SELECT hour::DateTime AS bucket, if(domain_code::String = 'en', 'desktop', 'mobile') AS series, sum(count_views::Int64) AS value
FROM ${PAGEVIEWS}
WHERE ${WIKIS} AND ${PAGE_TITLE} IN matches
GROUP BY bucket, series
ORDER BY bucket, series`;
    const [count, top, timeline] = await Promise.all([query(countSql), query(topSql), query(timelineSql)]);

    // Snippets for the most viewed articles; if the pageviews table has no match yet, fall back to arbitrary matching articles.
    const titles = top.data.map((row) => row.page_title.replaceAll('_', ' '));
    const hitsSql = `SELECT title::String AS title, url::String AS url,
       length(text::String) AS bytes,
       ${snippet('text::String', tokens)} AS snippet
FROM ${ARTICLES}
WHERE ${titles.length ? `title::String IN (${titles.map(literal).join(', ')})` : where}
LIMIT ${limit}`;
    const hits = await query(hitsSql);
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
        timeline: { title: 'Hourly pageviews of matching articles', kind: 'stack', result: timeline },
        queries: [{ title: 'Matching articles', ...count }, { title: 'Most viewed matches', ...top }, { title: 'Snippets', ...hits }],
    };
}

async function semanticSearch(params)
{
    const { tokens } = parseSearch(params);
    const limit = intParam(params, 'limit', 20, 1, 100);
    const hits = await semanticQuery(VECTORS, 'id::String AS id, title::String AS title, url::String AS url', params.get('q'), limit);

    const titles = hits.data.map((row) => row.title);
    const snippetsSql = `SELECT title::String AS title, substringUTF8(text::String, 1, 300) AS snippet
FROM ${ARTICLES}
WHERE ${titles.length ? `title::String IN (${titles.map(literal).join(', ')})` : '0'}`;
    const pageTitles = titles.map((title) => title.replaceAll(' ', '_'));
    const pageTitleList = pageTitles.length ? pageTitles.map(literal).join(', ') : "''";
    const viewsSql = `SELECT ${PAGE_TITLE} AS page_title, sum(count_views::Int64) AS views
FROM ${PAGEVIEWS}
WHERE ${WIKIS} AND ${PAGE_TITLE} IN (${pageTitleList})
GROUP BY page_title
ORDER BY views DESC`;
    const timelineSql = `SELECT hour::DateTime AS bucket, if(domain_code::String = 'en', 'desktop', 'mobile') AS series, sum(count_views::Int64) AS value
FROM ${PAGEVIEWS}
WHERE ${WIKIS} AND ${PAGE_TITLE} IN (${pageTitleList})
GROUP BY bucket, series
ORDER BY bucket, series`;
    const [snippets, views, timeline] = await Promise.all([
        query(snippetsSql),
        titles.length ? query(viewsSql) : Promise.resolve({ data: [], sql: viewsSql }),
        titles.length ? query(timelineSql) : Promise.resolve({ data: [], sql: timelineSql }),
    ]);
    const snippetsByTitle = new Map(snippets.data.map((row) => [row.title, row.snippet]));
    const viewsByTitle = new Map(views.data.map((row) => [row.page_title.replaceAll('_', ' '), Number(row.views)]));
    return {
        tokens,
        total: hits.data.length,
        hits: hits.data.map((row) =>
        {
            const pageviews = viewsByTitle.get(row.title) ?? 0;
            return {
                title: row.title,
                url: row.url,
                snippet: snippetsByTitle.get(row.title) ?? '',
                meta: [`${Number(row.score).toFixed(3)} similarity`, `${pageviews.toLocaleString('en-US')} views`],
            };
        }),
        timeline: { title: 'Hourly pageviews of matching articles', kind: 'stack', result: timeline },
        queries: [
            { title: 'Semantic article matches', ...hits },
            { title: 'Article snippets', ...snippets },
            { title: 'Matching pageviews', ...views },
            { title: 'Hourly pageviews', ...timeline },
        ],
    };
}

async function analytics(params)
{
    const { where, matches } = buildFilter(params);
    const topArticlesSql = `WITH ${matches},
top AS (
    SELECT ${PAGE_TITLE} AS t FROM ${PAGEVIEWS}
    WHERE ${WIKIS} AND ${PAGE_TITLE} IN matches
    GROUP BY t ORDER BY sum(count_views::Int64) DESC LIMIT 6
)
SELECT toStartOfInterval(hour::DateTime, INTERVAL 6 HOUR) AS bucket,
       replaceAll(if(${PAGE_TITLE} IN top, ${PAGE_TITLE}, 'other'), '_', ' ') AS series,
       sum(count_views::Int64) AS value
FROM ${PAGEVIEWS}
WHERE ${WIKIS} AND ${PAGE_TITLE} IN matches
GROUP BY bucket, series
ORDER BY bucket, value DESC`;
    const peakSql = `WITH ${matches}
SELECT argMax(hour, views) AS busiest_hour, max(views) AS busiest_hour_views, round(avg(views)) AS avg_views_per_hour,
       sum(views) AS total_views, round(sum(mobile) / sum(views) * 100, 1) AS mobile_percent
FROM
(
    SELECT hour::DateTime AS hour, sum(count_views::Int64) AS views,
           sumIf(count_views::Int64, domain_code::String = 'en.m') AS mobile
    FROM ${PAGEVIEWS}
    WHERE ${WIKIS} AND ${PAGE_TITLE} IN matches
    GROUP BY hour
)`;
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
        panel({ title: 'Pageviews of the top matching articles (6-hour buckets)', kind: 'stack', wide: true }, query(topArticlesSql)),
        panel({ title: 'Peak hour', kind: 'kv' }, query(peakSql)),
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
