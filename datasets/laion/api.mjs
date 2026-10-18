import { textVector, vectorLiteral } from '../../lib/clip.mjs';
import { query } from '../../lib/rawtree.mjs';
import { HttpError, intParam, panel, textCondition, tokenize } from '../../lib/search.mjs';
import { isNsfwText } from '../../lib/nsfw_text.mjs';

const TABLE = 'laion_images';
const CAPTION = 'lowerUTF8(caption::String)';

function vectorPreview()
{
    return '[…512 floats]::Array(Float32)';
}

function semanticSql(vector, limit)
{
    const literal = vectorLiteral(vector);
    const sql = `SELECT id::Int64 AS id, url::String AS url, caption::String AS caption,
       width::Int64 AS width, height::Int64 AS height, similarity::Float64 AS similarity,
       1 - cosineDistance(vector::Array(Float32), ${literal}) AS score
FROM ${TABLE}
ORDER BY cosineDistance(vector::Array(Float32), ${literal})
LIMIT ${limit}`;
    const displayLiteral = vectorPreview();
    return {
        sql,
        displaySql: sql.replaceAll(literal, displayLiteral),
    };
}

async function images(params)
{
    const q = (params.get('q') ?? '').trim();
    if (isNsfwText(q))
        return { blocked: true, tokens: [], total: 0, hits: [], queries: [] };

    const mode = params.get('mode') === 'caption' ? 'caption' : 'semantic';
    const limit = intParam(params, 'limit', 48, 1, 96);
    const similarText = (params.get('similar') ?? '').trim();
    let similar = null;
    if (similarText)
    {
        if (!/^\d+$/.test(similarText) || !Number.isSafeInteger(Number(similarText)))
            throw new HttpError(400, 'Invalid similar image id');
        similar = Number(similarText);
    }

    if (mode === 'caption')
    {
        const tokens = tokenize(q);
        if (!tokens.length)
            throw new HttpError(400, 'Enter at least one caption word');
        const where = textCondition(CAPTION, tokens, 'all');
        const hitsSql = `SELECT id::Int64 AS id, url::String AS url, caption::String AS caption,
       width::Int64 AS width, height::Int64 AS height, similarity::Float64 AS similarity,
       similarity::Float64 AS score
FROM ${TABLE}
WHERE ${where}
ORDER BY similarity::Float64 DESC
LIMIT ${limit}`;
        const countSql = `SELECT count() AS matches
FROM ${TABLE}
WHERE ${where}`;
        const [hits, count] = await Promise.all([query(hitsSql), query(countSql)]);
        return {
            tokens,
            total: Number(count.data[0]?.matches ?? 0),
            hits: hits.data,
            queries: [{ title: 'Caption matches', ...hits }, { title: 'Matching captions', ...count }],
        };
    }

    if (!q && similar === null)
        throw new HttpError(400, 'Enter a query or choose a similar image');
    let vector;
    let sourceQuery;
    if (similar !== null)
    {
        sourceQuery = await query(`SELECT vector::Array(Float32) AS vector
FROM ${TABLE}
WHERE id::Int64 = ${similar}
LIMIT 1`);
        vector = sourceQuery.data[0]?.vector;
        if (!Array.isArray(vector) || vector.length !== 512)
            throw new HttpError(404, 'Similar image not found');
    }
    else
        vector = await textVector(q);

    const limitSql = limit + (similar === null ? 0 : 1);
    const { sql, displaySql } = semanticSql(vector, limitSql);
    const hits = await query(sql, { displaySql });
    const rows = hits.data
        .filter((row) => similar === null || Number(row.id) !== similar)
        .slice(0, limit);
    return {
        tokens: tokenize(q),
        total: rows.length,
        hits: rows,
        queries: [
            ...(sourceQuery ? [{ title: 'Similar image vector', ...sourceQuery }] : []),
            { title: similar === null ? 'Semantic image matches' : 'Similar images', ...hits },
        ],
    };
}

function analyticsWhere(params)
{
    const tokens = tokenize(params.get('q'));
    return tokens.length ? textCondition(CAPTION, tokens, 'all') : '1';
}

async function analytics(params)
{
    const where = analyticsWhere(params);
    const domains = `SELECT domain(url::String) AS label, count() AS value
FROM ${TABLE}
WHERE ${where}
GROUP BY label
ORDER BY value DESC
LIMIT 10`;
    const sizes = `SELECT multiIf(max_side < 256, '< 256 px', max_side < 512, '256–511 px', max_side < 1024, '512–1023 px', '1024+ px') AS label,
       count() AS value, min(max_side) AS order_value
FROM
(
    SELECT greatest(width::Int64, height::Int64) AS max_side
    FROM ${TABLE}
    WHERE ${where}
)
GROUP BY label
ORDER BY order_value`;
    const aspects = `SELECT multiIf(width::Int64 = height::Int64, 'square', width::Int64 > height::Int64, 'landscape', 'portrait') AS label,
       count() AS value
FROM ${TABLE}
WHERE ${where} AND width::Int64 > 0 AND height::Int64 > 0
GROUP BY label
ORDER BY value DESC`;
    const captions = `SELECT multiIf(chars < 40, '< 40 chars', chars < 100, '40–99 chars', chars < 250, '100–249 chars', '250+ chars') AS label,
       count() AS value, min(chars) AS order_value
FROM (SELECT lengthUTF8(caption::String) AS chars FROM ${TABLE} WHERE ${where})
GROUP BY label
ORDER BY order_value`;
    const licenses = `SELECT if(license::String = '', 'unknown', license::String) AS label, count() AS value
FROM ${TABLE}
WHERE ${where}
GROUP BY label
ORDER BY value DESC
LIMIT 10`;
    const panels = await Promise.all([
        panel({ title: 'Top image domains', kind: 'bars' }, query(domains)),
        panel({ title: 'Image dimensions', kind: 'bars' }, query(sizes)),
        panel({ title: 'Image aspect ratios', kind: 'bars' }, query(aspects)),
        panel({ title: 'Caption lengths', kind: 'bars' }, query(captions)),
        panel({ title: 'Image licenses', kind: 'bars' }, query(licenses)),
    ]);
    return { panels };
}

async function stats()
{
    const result = await query(`SELECT count() AS images, round(avg(similarity::Float64), 4) AS avg_similarity,
       uniqExact(shard::Int64) AS shards
FROM ${TABLE}`);
    return result.data[0];
}

export default {
    id: 'laion',
    title: 'LAION-400M',
    description: 'Semantic image search across public images and captions, using CLIP ViT-B/32 embeddings.',
    routes: { images, analytics, stats },
};
