import { literal, query } from '../../lib/rawtree.mjs';
import { intParam, panel, parseSearch, snippet, textCondition } from '../../lib/search.mjs';

const TABLE = 'arxiv_papers';
const TITLE = 'lowerUTF8(title::String)';
const ABSTRACT = 'lowerUTF8(abstract::String)';
const FIELDS = ['both', 'title', 'abstract'];
const FIRST_CREATED = `arrayElement(versions::Array(Tuple(version String, created String)), 1).created`;
const FIRST_DATE = `parseDateTimeBestEffortOrNull(${FIRST_CREATED})`;

function buildFilter(params)
{
    const { tokens, mode } = parseSearch(params);
    const field = FIELDS.includes(params.get('field')) ? params.get('field') : 'both';
    const conditions = [{
        both: `(${textCondition(TITLE, tokens, mode)} OR ${textCondition(ABSTRACT, tokens, mode)})`,
        title: textCondition(TITLE, tokens, mode),
        abstract: textCondition(ABSTRACT, tokens, mode),
    }[field]];
    const category = (params.get('category') ?? '').trim();
    if (category && /^[A-Za-z0-9.-]{1,40}$/.test(category))
        conditions.push(`arrayExists(c -> c = ${literal(category)} OR startsWith(c, concat(${literal(category)}, '.')), splitByChar(' ', categories::String))`);
    const from = intParam(params, 'from', 1986, 1986, 2026);
    const to = intParam(params, 'to', 2026, 1986, 2026);
    if (from > 1986)
        conditions.push(`${FIRST_DATE} >= toDateTime('${from}-01-01 00:00:00')`);
    if (to < 2026)
        conditions.push(`${FIRST_DATE} < toDateTime('${to + 1}-01-01 00:00:00')`);
    return { tokens, where: conditions.join('\n  AND ') };
}

async function search(params)
{
    const { tokens, where } = buildFilter(params);
    const limit = intParam(params, 'limit', 20, 1, 100);
    const hitsSql = `SELECT id::String AS id, title::String AS title, authors::String AS authors,
       categories::String AS categories, ${FIRST_DATE} AS first_submission,
       ${snippet('abstract::String', tokens)} AS snippet
FROM ${TABLE}
WHERE ${where}
ORDER BY ${FIRST_DATE} DESC
LIMIT ${limit}`;
    const countSql = `SELECT count() AS matches FROM ${TABLE} WHERE ${where}`;
    const timelineSql = `SELECT toStartOfYear(${FIRST_DATE}) AS bucket, 'papers' AS series, count() AS value
FROM ${TABLE}
WHERE ${where}
GROUP BY bucket, series
ORDER BY bucket`;
    const [hits, count, timeline] = await Promise.all([query(hitsSql), query(countSql), query(timelineSql)]);
    return {
        tokens,
        total: Number(count.data[0]?.matches ?? 0),
        hits: hits.data.map((row) =>
        {
            const authors = String(row.authors ?? '');
            return {
                title: row.title,
                url: `https://arxiv.org/abs/${encodeURIComponent(row.id)}`,
                snippet: row.snippet,
                meta: [
                    authors.length > 100 ? `${authors.slice(0, 97)}…` : authors,
                    row.categories ?? '',
                    String(row.first_submission).slice(0, 10),
                ],
            };
        }),
        timeline: { title: 'Matching papers by first submission year', kind: 'stack', result: timeline },
        queries: [{ title: 'Newest matching papers', ...hits }, { title: 'Matching papers', ...count }],
    };
}

async function analytics(params)
{
    const { where } = buildFilter(params);
    const perYearSql = `WITH top_categories AS (
    SELECT arrayJoin(splitByChar(' ', categories::String)) AS category FROM ${TABLE}
    WHERE ${where}
    GROUP BY category ORDER BY count() DESC LIMIT 5
)
SELECT toYear(${FIRST_DATE}) AS bucket,
       if(arrayFirst(c -> c IN top_categories, splitByChar(' ', categories::String)) AS top_category = '', 'other', top_category) AS series,
       count() AS value
FROM ${TABLE}
WHERE ${where}
GROUP BY bucket, series
ORDER BY bucket, value DESC`;
    const categoriesSql = `SELECT arrayJoin(splitByChar(' ', categories::String)) AS label, count() AS value
FROM ${TABLE}
WHERE ${where}
GROUP BY label
ORDER BY value DESC
LIMIT 12`;
    const submittersSql = `SELECT submitter::String AS label, count() AS value
FROM ${TABLE}
WHERE ${where}
GROUP BY label
ORDER BY value DESC
LIMIT 12`;
    const summarySql = `SELECT count() AS papers, min(toYear(${FIRST_DATE})) AS first_year,
       max(toYear(${FIRST_DATE})) AS last_year
FROM ${TABLE}
WHERE ${where}`;
    const panels = await Promise.all([
        panel({ title: 'Papers per year by top category', kind: 'stack', wide: true }, query(perYearSql)),
        panel({ title: 'Top categories', kind: 'bars' }, query(categoriesSql)),
        panel({ title: 'Top submitters', kind: 'bars' }, query(submittersSql)),
        panel({ title: 'Matching papers', kind: 'kv' }, query(summarySql)),
    ]);
    return { panels };
}

async function stats()
{
    const result = await query(`SELECT count() AS papers, min(toYear(${FIRST_DATE})) AS first_year, max(toYear(${FIRST_DATE})) AS last_year FROM ${TABLE}`);
    return result.data[0];
}

export default {
    id: 'arxiv',
    title: 'arXiv',
    description: 'Search arXiv titles and abstracts by archive category and first submission year.',
    routes: { search, analytics, stats },
};
