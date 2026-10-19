// Search, analytics and stats for Stack Overflow posts (`stackoverflow_posts`, questions and answers 2008-2024).
import { semanticQuery } from '../../lib/text_embed.mjs';
import { literal, query } from '../../lib/rawtree.mjs';
import { intParam, panel, parseSearch, snippet, textCondition } from '../../lib/search.mjs';

const POSTS = 'stackoverflow_posts';
const TITLE = 'lowerUTF8(Title::String)';
const BODY = 'lowerUTF8(Body::String)';
const TYPES = { questions: 'PostTypeId::Int64 = 1', answers: 'PostTypeId::Int64 = 2', all: 'PostTypeId::Int64 IN (1, 2)' };
const FIELDS = ['body', 'title', 'both'];
const CREATED = 'CreationDate::DateTime64(3)';
const TAGS = `arrayFilter(t -> t != '', splitByChar('|', Tags::String))`;
const PLAIN_BODY = `replaceRegexpAll(replaceRegexpAll(Body::String, '<[^>]*>', ' '), '\\\\s+', ' ')`;
// Embeddings were not reloaded into the dataset database and stay in `default`.
const VECTORS = 'default.stackoverflow_vectors';

function buildFilter(params)
{
    const { tokens, mode } = parseSearch(params);
    const field = FIELDS.includes(params.get('field')) ? params.get('field') : 'both';
    const type = TYPES[params.get('type')] ? params.get('type') : 'all';
    const conditions = [TYPES[type]];
    conditions.push({
        body: textCondition(BODY, tokens, mode),
        title: textCondition(TITLE, tokens, mode),
        both: `(${textCondition(TITLE, tokens, mode)} OR ${textCondition(BODY, tokens, mode)})`,
    }[field]);
    const tag = (params.get('tag') ?? '').trim().toLowerCase();
    if (tag && /^[a-z0-9.+#-]{1,40}$/.test(tag))
        conditions.push(`position(Tags::String, ${literal(`|${tag}|`)}) > 0`);
    const from = intParam(params, 'from', 2008, 2008, 2024);
    const to = intParam(params, 'to', 2024, 2008, 2024);
    if (from > 2008)
        conditions.push(`${CREATED} >= toDateTime64('${from}-01-01 00:00:00', 3)`);
    if (to < 2024)
        conditions.push(`${CREATED} < toDateTime64('${to + 1}-01-01 00:00:00', 3)`);
    return { tokens, where: conditions.join('\n  AND ') };
}

const postUrl = (row) => `https://stackoverflow.com/${row.type === 1 ? 'q' : 'a'}/${row.id}`;

async function search(params)
{
    if (params.get('mode') === 'semantic')
        return semanticSearch(params);

    const { tokens, where } = buildFilter(params);
    const limit = intParam(params, 'limit', 20, 1, 100);
    const sort = params.get('sort') === 'recent' ? `${CREATED} DESC` : 'Score::Int64 DESC';
    const hitsSql = `SELECT Id::Int64 AS id, PostTypeId::Int64 AS type,
       toInt64OrZero(toString(ParentId)) AS parent_id,
       Title::String AS title, Tags::String AS tags,
       Score::Int64 AS score, ViewCount::Int64 AS views, AnswerCount::Int64 AS answers,
       ${CREATED} AS created,
       ${snippet(PLAIN_BODY, tokens)} AS snippet
FROM ${POSTS}
WHERE ${where}
ORDER BY ${sort}
LIMIT ${limit}`;
    const countSql = `SELECT count() AS matches, countIf(PostTypeId::Int64 = 1) AS questions, countIf(PostTypeId::Int64 = 2) AS answers
FROM ${POSTS}
WHERE ${where}`;
    const timelineSql = `SELECT toStartOfMonth(${CREATED}) AS bucket, if(PostTypeId::Int64 = 1, 'questions', 'answers') AS series, count() AS value
FROM ${POSTS}
WHERE ${where}
GROUP BY bucket, series
ORDER BY bucket, series`;
    const [hits, count, timeline] = await Promise.all([query(hitsSql), query(countSql), query(timelineSql)]);

    // Answers have no title or tags: take them from the parent question.
    const parentIds = [...new Set(hits.data.filter((row) => row.type === 2 && row.parent_id).map((row) => Number(row.parent_id)))];
    let parents = null;
    if (parentIds.length)
        parents = await query(`SELECT Id::Int64 AS id, Title::String AS title, Tags::String AS tags
FROM ${POSTS}
WHERE PostTypeId::Int64 = 1 AND Id::Int64 IN (${parentIds.join(', ')})`);
    const byId = new Map((parents?.data ?? []).map((row) => [Number(row.id), row]));
    const rows = hits.data.map((row) =>
    {
        const parent = byId.get(Number(row.parent_id));
        const tags = (row.tags || parent?.tags || '').split('|').filter(Boolean);
        return {
            title: row.type === 1 ? row.title : `Answer: ${parent?.title ?? `question ${row.parent_id}`}`,
            url: postUrl(row),
            snippet: row.snippet,
            meta: [
                `${row.score} score`,
                ...(row.type === 1 ? [`${Number(row.views).toLocaleString('en-US')} views`, `${row.answers} answers`] : []),
                String(row.created).slice(0, 10),
            ],
            tags,
        };
    });
    return {
        tokens,
        total: Number(count.data[0]?.matches ?? 0),
        hits: rows,
        timeline: { title: 'Matching posts per month', kind: 'stack', result: timeline },
        queries: [{ title: 'Top posts', ...hits }, { title: 'Matching posts', ...count }, ...(parents ? [{ title: 'Parent questions', ...parents }] : [])],
    };
}

async function semanticSearch(params)
{
    const { tokens } = parseSearch(params);
    const limit = intParam(params, 'limit', 20, 1, 100);
    const hits = await semanticQuery(VECTORS, `Id::Int64 AS id, Title::String AS title, Tags::String AS tags,
       Score::Int64 AS post_score, ViewCount::Int64 AS views, AnswerCount::Int64 AS answers,
       CreationDate::DateTime64(3) AS created`, params.get('q'), limit);

    const ids = hits.data.map((row) => Number(row.id)).filter(Number.isSafeInteger);
    const snippetsSql = `SELECT Id::Int64 AS id, substringUTF8(${PLAIN_BODY}, 1, 300) AS snippet
FROM ${POSTS}
WHERE ${ids.length ? `Id::Int64 IN (${ids.join(', ')})` : '0'}`;
    const snippets = ids.length ? await query(snippetsSql) : { data: [], sql: snippetsSql };
    const snippetsById = new Map(snippets.data.map((row) => [Number(row.id), row.snippet]));
    return {
        tokens,
        total: hits.data.length,
        hits: hits.data.map((row) =>
        {
            const id = Number(row.id);
            const tags = String(row.tags ?? '').split('|').filter(Boolean);
            return {
                title: row.title,
                url: `https://stackoverflow.com/q/${id}`,
                snippet: snippetsById.get(id) ?? '',
                meta: [
                    `${Number(row.score).toFixed(3)} similarity`,
                    `${row.post_score} score`,
                    `${Number(row.views).toLocaleString('en-US')} views`,
                    `${row.answers} answers`,
                    String(row.created).slice(0, 10),
                ],
                tags,
            };
        }),
        queries: [
            { title: 'Semantic question matches', ...hits },
            { title: 'Question snippets', ...snippets },
        ],
    };
}

async function analytics(params)
{
    const { where } = buildFilter(params);
    const perTagSql = `WITH top_tags AS (
    SELECT arrayJoin(${TAGS}) AS tag FROM ${POSTS}
    WHERE ${where}
    GROUP BY tag ORDER BY count() DESC LIMIT 6
)
SELECT toStartOfQuarter(${CREATED}) AS bucket,
       if(arrayFirst(t -> t IN top_tags, ${TAGS}) AS first_top_tag = '', 'other', first_top_tag) AS series,
       count() AS value
FROM ${POSTS}
WHERE ${where} AND PostTypeId::Int64 = 1
GROUP BY bucket, series
ORDER BY bucket, value DESC`;
    const tagsSql = `SELECT arrayJoin(${TAGS}) AS label, count() AS value
FROM ${POSTS}
WHERE ${where} AND PostTypeId::Int64 = 1
GROUP BY label ORDER BY value DESC LIMIT 12`;
    const peakSql = `SELECT argMax(month, posts) AS busiest_month, max(posts) AS busiest_month_posts, round(avg(posts)) AS avg_posts_per_month, sum(posts) AS total_posts
FROM
(
    SELECT toStartOfMonth(${CREATED}) AS month, count() AS posts
    FROM ${POSTS}
    WHERE ${where}
    GROUP BY month
)`;
    const qualitySql = `SELECT round(avg(Score::Int64), 2) AS avg_score,
       round(countIf(toInt64OrZero(toString(AcceptedAnswerId)) > 0) / count() * 100, 1) AS accepted_percent,
       round(avg(AnswerCount::Int64), 2) AS avg_answers,
       quantile(0.5)(ViewCount::Int64) AS median_views,
       max(ViewCount::Int64) AS max_views
FROM ${POSTS}
WHERE ${where} AND PostTypeId::Int64 = 1`;
    const panels = await Promise.all([
        panel({ title: 'Matching questions per quarter by top tag', kind: 'stack', wide: true }, query(perTagSql)),
        panel({ title: 'Peak month', kind: 'kv' }, query(peakSql)),
        panel({ title: 'Top tags of matching questions', kind: 'bars' }, query(tagsSql)),
        panel({ title: 'Matching questions', kind: 'kv' }, query(qualitySql)),
    ]);
    return { panels };
}

async function stats()
{
    const result = await query(`SELECT count() AS posts, countIf(PostTypeId::Int64 = 1) AS questions, countIf(PostTypeId::Int64 = 2) AS answers,
       min(${CREATED}) AS first_post, max(${CREATED}) AS last_post
FROM ${POSTS}`);
    return result.data[0];
}

export default {
    id: 'stackoverflow',
    title: 'Stack Overflow',
    description: 'Full-text search over Stack Overflow questions and answers (2008-2024), with tag, score and time analytics.',
    routes: { search, analytics, stats },
};
