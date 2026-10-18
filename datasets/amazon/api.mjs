import { literal, query } from '../../lib/rawtree.mjs';
import { intParam, panel, parseSearch, snippet, textCondition } from '../../lib/search.mjs';

const TABLE = 'amazon_reviews';
const HEADLINE = 'lowerUTF8(review_headline::String)';
const BODY = 'lowerUTF8(review_body::String)';
const PLAIN_BODY = `replaceRegexpAll(replaceRegexpAll(review_body::String, '<[^>]*>', ' '), '\\\\s+', ' ')`;
const REVIEW_DATE = `toDate('1970-01-01') + review_date::UInt16`;
const FIELDS = ['both', 'headline', 'body'];

function buildFilter(params)
{
    const { tokens, mode } = parseSearch(params);
    const field = FIELDS.includes(params.get('field')) ? params.get('field') : 'both';
    const conditions = [{
        both: `(${textCondition(HEADLINE, tokens, mode)} OR ${textCondition(BODY, tokens, mode)})`,
        headline: textCondition(HEADLINE, tokens, mode),
        body: textCondition(BODY, tokens, mode),
    }[field]];
    const category = (params.get('category') ?? '').trim();
    if (category && category.length <= 128)
        conditions.push(`product_category::String = ${literal(category)}`);
    const rating = params.get('rating');
    if (/^[1-5]$/.test(rating ?? ''))
        conditions.push(`star_rating::Int64 = ${Number(rating)}`);
    if (params.get('verified') === 'yes')
        conditions.push('verified_purchase::Bool = true');
    const from = intParam(params, 'from', 1995, 1995, 2015);
    const to = intParam(params, 'to', 2015, 1995, 2015);
    conditions.push(`${REVIEW_DATE} >= toDate('${from}-01-01')`);
    conditions.push(`${REVIEW_DATE} < toDate('${to + 1}-01-01')`);
    return { tokens, where: conditions.join('\n  AND ') };
}

async function search(params)
{
    const { tokens, where } = buildFilter(params);
    const limit = intParam(params, 'limit', 20, 1, 100);
    const order = params.get('sort') === 'recent'
        ? `${REVIEW_DATE} DESC`
        : 'helpful_votes::Int64 DESC, total_votes::Int64 DESC';
    const hitsSql = `SELECT review_id::String AS id, product_id::String AS product_id,
       product_title::String AS product_title, review_headline::String AS headline,
       star_rating::Int64 AS rating, helpful_votes::Int64 AS helpful, total_votes::Int64 AS total_votes,
       verified_purchase::Bool AS verified, product_category::String AS category,
       ${REVIEW_DATE} AS review_date, ${snippet(PLAIN_BODY, tokens)} AS snippet
FROM ${TABLE}
WHERE ${where}
ORDER BY ${order}
LIMIT ${limit}`;
    const countSql = `SELECT count() AS matches FROM ${TABLE} WHERE ${where}`;
    const timelineSql = `SELECT toStartOfQuarter(${REVIEW_DATE}) AS label, count() AS value
FROM ${TABLE}
WHERE ${where}
GROUP BY label
ORDER BY label`;
    const [hits, count, timeline] = await Promise.all([query(hitsSql), query(countSql), query(timelineSql)]);
    return {
        tokens,
        total: Number(count.data[0]?.matches ?? 0),
        hits: hits.data.map((row) => ({
            title: `${row.product_title} · ${'★'.repeat(Math.max(0, Number(row.rating)))}`,
            url: `https://www.amazon.com/dp/${encodeURIComponent(row.product_id)}`,
            snippet: row.snippet,
            meta: [
                `${row.rating}/5`,
                `${row.helpful} helpful votes`,
                String(row.review_date).slice(0, 10),
                row.category,
                ...(row.verified ? ['verified purchase'] : []),
            ],
        })),
        timeline: { title: 'Matching reviews per quarter', kind: 'bars', result: timeline },
        queries: [{ title: 'Top reviews', ...hits }, { title: 'Matching reviews', ...count }],
    };
}

async function analytics(params)
{
    const { where } = buildFilter(params);
    const ratingSql = `SELECT toString(star_rating::Int64) AS label, count() AS value
FROM ${TABLE}
WHERE ${where}
GROUP BY label
ORDER BY label DESC`;
    const quarterSql = `WITH top_categories AS (
    SELECT product_category::String AS category FROM ${TABLE}
    WHERE ${where}
    GROUP BY category ORDER BY count() DESC LIMIT 5
)
SELECT toStartOfQuarter(${REVIEW_DATE}) AS bucket,
       if(product_category::String IN top_categories, product_category::String, 'other') AS series,
       count() AS value
FROM ${TABLE}
WHERE ${where}
GROUP BY bucket, series
ORDER BY bucket, value DESC`;
    const categoriesSql = `SELECT product_category::String AS label, count() AS value
FROM ${TABLE}
WHERE ${where}
GROUP BY label
ORDER BY value DESC
LIMIT 12`;
    const yearlySql = `SELECT toYear(${REVIEW_DATE}) AS label, round(avg(star_rating::Int64), 2) AS value
FROM ${TABLE}
WHERE ${where}
GROUP BY label
ORDER BY label`;
    const productsSql = `SELECT product_title::String AS label, product_id::String AS product_id,
       count() AS value, round(avg(star_rating::Int64), 2) AS average_rating
FROM ${TABLE}
WHERE ${where}
GROUP BY label, product_id
ORDER BY value DESC
LIMIT 10`;
    const panels = await Promise.all([
        panel({ title: 'Rating distribution', kind: 'bars' }, query(ratingSql)),
        panel({ title: 'Reviews per quarter by top category', kind: 'stack', wide: true }, query(quarterSql)),
        panel({ title: 'Top categories', kind: 'bars' }, query(categoriesSql)),
        panel({ title: 'Average rating by year', kind: 'bars' }, query(yearlySql)),
        panel({ title: 'Top products', kind: 'bars' }, query(productsSql)),
    ]);
    return { panels };
}

async function stats()
{
    const result = await query(`SELECT count() AS reviews, round(avg(star_rating::Int64), 2) AS avg_rating FROM ${TABLE}`);
    return result.data[0];
}

export default {
    id: 'amazon',
    title: 'Amazon reviews',
    description: 'Search Amazon customer reviews from the 1990s through 2015 by headline, body, rating and product category.',
    routes: { search, analytics, stats },
};
