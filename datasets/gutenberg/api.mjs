import { literal, query } from '../../lib/rawtree.mjs';
import { intParam, panel, parseSearch, snippet, textCondition } from '../../lib/search.mjs';

const TABLE = 'gutenberg_books';
const META = 'METADATA::String';
const TEXT = 'TEXT::String';
const LOWER_TEXT = 'lowerUTF8(TEXT::String)';
const TITLE = `lowerUTF8(JSONExtractString(${META}, 'title'))`;
const AUTHORS_RAW = `JSONExtractRaw(${META}, 'authors')`;
const AUTHORS = `lowerUTF8(${AUTHORS_RAW})`;
const ISSUED = `parseDateTimeBestEffortOrNull(JSONExtractString(${META}, 'issued'))`;
const SUBJECTS = `splitByString('; ', JSONExtractString(${META}, 'subjects'))`;
const SHELVES = `splitByString('; ', JSONExtractString(${META}, 'bookshelves'))`;
const FIELDS = ['text', 'title', 'author'];

function wordsCondition(expr, tokens, mode)
{
    if (mode === 'phrase') return `positionCaseInsensitiveUTF8(${expr}, ${literal(tokens.join(' '))}) > 0`;
    return tokens.map((token) => `positionCaseInsensitiveUTF8(${expr}, ${literal(token)}) > 0`).join(mode === 'any' ? ' OR ' : ' AND ');
}

function buildFilter(params)
{
    const { tokens, mode } = parseSearch(params);
    const field = FIELDS.includes(params.get('field')) ? params.get('field') : 'text';
    const expr = field === 'text' ? LOWER_TEXT : field === 'title' ? TITLE : AUTHORS;
    const conditions = [field === 'text' ? textCondition(expr, tokens, mode) : `(${wordsCondition(expr, tokens, mode)})`];
    for (const [key, column] of [['author', AUTHORS], ['subject', `lowerUTF8(JSONExtractString(${META}, 'subjects'))`], ['bookshelf', `lowerUTF8(JSONExtractString(${META}, 'bookshelves'))`]])
    {
        const value = (params.get(key) ?? '').trim();
        if (value) conditions.push(`positionCaseInsensitiveUTF8(${column}, ${literal(value.toLowerCase())}) > 0`);
    }
    const from = intParam(params, 'from', 1000, 1000, 2025);
    const to = intParam(params, 'to', 2025, 1000, 2025);
    if (from > 1000) conditions.push(`${ISSUED} >= toDateTime('${from}-01-01 00:00:00')`);
    if (to < 2025) conditions.push(`${ISSUED} < toDateTime('${to + 1}-01-01 00:00:00')`);
    return { tokens, where: conditions.join('\n  AND ') };
}

function displayAuthors(raw)
{
    try
    {
        const value = JSON.parse(raw);
        return Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : raw;
    }
    catch { return raw || ''; }
}

async function search(params)
{
    const { tokens, where } = buildFilter(params);
    const limit = intParam(params, 'limit', 20, 1, 100);
    const order = params.get('sort') === 'title' ? `JSONExtractString(${META}, 'title')` : `lengthUTF8(${TEXT}) DESC`;
    const hitsSql = `SELECT JSONExtractInt(${META}, 'text_id') AS id, JSONExtractString(${META}, 'title') AS title,
       ${AUTHORS_RAW} AS authors, JSONExtractString(${META}, 'issued') AS issued,
       ${snippet(TEXT, tokens)} AS snippet, lengthUTF8(${TEXT}) AS text_length
FROM ${TABLE} WHERE ${where} ORDER BY ${order} LIMIT ${limit}`;
    const countSql = `SELECT count() AS matches FROM ${TABLE} WHERE ${where}`;
    const [hits, count] = await Promise.all([query(hitsSql), query(countSql)]);
    return {
        tokens, total: Number(count.data[0]?.matches ?? 0),
        hits: hits.data.map((row) => ({
            title: row.title || `Project Gutenberg ebook ${row.id}`,
            url: `https://www.gutenberg.org/ebooks/${row.id}`,
            snippet: row.snippet,
            meta: [displayAuthors(row.authors), String(row.issued ?? '').slice(0, 4), `${Number(row.text_length).toLocaleString('en-US')} characters`].filter(Boolean),
        })),
        timeline: null, queries: [{ title: 'Matching books', ...hits }, { title: 'Matching books', ...count }],
    };
}

async function analytics(params)
{
    const { where } = buildFilter(params);
    const authors = `arrayJoin(if(startsWith(${AUTHORS_RAW}, '['), JSONExtract(${META}, 'authors', 'Array(String)'), [JSONExtractString(${META}, 'authors')]))`;
    const queries = [
        `SELECT ${authors} AS label, count() AS value FROM ${TABLE} WHERE ${where} GROUP BY label HAVING label != '' ORDER BY value DESC LIMIT 12`,
        `SELECT arrayJoin(${SUBJECTS}) AS label, count() AS value FROM ${TABLE} WHERE ${where} GROUP BY label HAVING label != '' ORDER BY value DESC LIMIT 12`,
        `SELECT arrayJoin(${SHELVES}) AS label, count() AS value FROM ${TABLE} WHERE ${where} GROUP BY label HAVING label != '' ORDER BY value DESC LIMIT 12`,
        `SELECT toYear(${ISSUED}) AS label, count() AS value FROM ${TABLE} WHERE ${where} AND ${ISSUED} IS NOT NULL GROUP BY label ORDER BY label`,
        `SELECT multiIf(lengthUTF8(${TEXT}) < 10000, '<10K', lengthUTF8(${TEXT}) < 50000, '10–50K', lengthUTF8(${TEXT}) < 100000, '50–100K', lengthUTF8(${TEXT}) < 250000, '100–250K', '250K+') AS label, count() AS value FROM ${TABLE} WHERE ${where} GROUP BY label ORDER BY label`,
    ];
    const panels = await Promise.all(queries.map((sql, i) => panel({
        title: ['Top authors', 'Top subjects', 'Top bookshelves', 'Books added to Gutenberg by year', 'Text length distribution'][i], kind: 'bars',
    }, query(sql))));
    return { panels };
}

async function stats()
{
    const result = await query(`SELECT count() AS books, sum(lengthUTF8(${TEXT})) AS total_text_chars FROM ${TABLE}`);
    return result.data[0];
}

export default { id: 'gutenberg', title: 'Gutenberg', description: 'Search whole Project Gutenberg books by text, title and author.', routes: { search, analytics, stats } };
