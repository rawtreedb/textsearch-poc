import { env, pipeline } from '@huggingface/transformers';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMissingTable, query } from './rawtree.mjs';
import { HttpError } from './search.mjs';
import { vectorLiteral } from './vector.mjs';

export const DIMENSIONS = 384;
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const MAX_CHARS = 2000;
const MAX_TOKENS = 256;
const here = dirname(fileURLToPath(import.meta.url));

env.cacheDir = process.env.MODELS_DIR ?? resolve(here, '../models');
env.allowRemoteModels = !['0', 'false', 'no'].includes((process.env.ALLOW_REMOTE_MODELS ?? 'true').toLowerCase());

let extractor;
let initialization;

async function initialize(threads)
{
    if (!initialization)
        initialization = (async () =>
        {
            extractor = await pipeline('feature-extraction', MODEL, {
                dtype: 'q8',
                session_options: {
                    intraOpNumThreads: Number(threads) || 0,
                    interOpNumThreads: 1,
                },
            });
            extractor.tokenizer.model_max_length = MAX_TOKENS;
        })();
    await initialization;
}

export async function embedTexts(texts, { threads } = {})
{
    if (!Array.isArray(texts) || texts.length === 0)
        return [];
    await initialize(threads);
    const inputs = texts.map((text) => String(text ?? '').slice(0, MAX_CHARS));
    const output = await extractor(inputs, { pooling: 'mean', normalize: true });
    if (output.dims.at(-1) !== DIMENSIONS || output.dims[0] !== texts.length)
        throw new Error(`Unexpected text embedding dimensions: ${output.dims.join('x')}`);
    return texts.map((_, row) => Float32Array.from(output.data.slice(row * DIMENSIONS, (row + 1) * DIMENSIONS)));
}

export async function embedText(text, options)
{
    const [vector] = await embedTexts([String(text ?? '')], options);
    return vector;
}

export async function semanticQuery(table, selectSql, q, limit)
{
    const vectorSql = vectorLiteral(await embedText(q));
    const hitsSql = `SELECT ${selectSql},
       1 - cosineDistance(vector::Array(Float32), ${vectorSql}) AS score
FROM ${table}
ORDER BY cosineDistance(vector::Array(Float32), ${vectorSql})
LIMIT ${limit}`;
    const displaySql = hitsSql.replaceAll(vectorSql, '[…384 floats]::Array(Float32)');
    try
    {
        return await query(hitsSql, { displaySql });
    }
    catch (error)
    {
        if (isMissingTable(error))
            throw new HttpError(503, 'Semantic index is still loading');
        throw error;
    }
}
