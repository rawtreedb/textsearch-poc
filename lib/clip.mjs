import { AutoTokenizer, CLIPTextModelWithProjection, env } from '@huggingface/transformers';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export { vectorLiteral } from './vector.mjs';

const MODEL = 'Xenova/clip-vit-base-patch32';
const DIMENSIONS = 512;
const UNSAFE_PROMPTS = [
    'a nude photo',
    'explicit sexual content',
    'pornography',
    'a photo of a naked person',
    'graphic gore, blood and violence',
    'a photo of a person in underwear or lingerie',
    'an explicit hentai drawing',
    'a sexually explicit drawing',
    'a photo of genitals',
    'a sexy photo of a woman\'s body',
    'a photo of a shirtless man posing',
    'a selfie of a woman in a bikini',
];
const SAFE_PROMPTS = [
    'a photo of a fully clothed person',
    'a selfie',
    'a meme with text',
    'a screenshot of a phone app',
    'a landscape photo',
    'a drawing or illustration',
    'an anime character illustration',
    'a photo of food',
    'a photo of a pet',
    'a photo of a city street',
    'a cartoon',
    'a photo of a group of people',
    'a product photo',
    'a poster with text',
];
const CLIP_LOGIT_SCALE = 100;
const here = dirname(fileURLToPath(import.meta.url));

env.cacheDir = process.env.MODELS_DIR ?? resolve(here, '../models');
env.allowRemoteModels = !['0', 'false', 'no'].includes((process.env.ALLOW_REMOTE_MODELS ?? 'true').toLowerCase());

let tokenizer;
let textModel;
let promptVectors;
let initialization;

function normalized(values)
{
    let squaredNorm = 0;
    for (const value of values)
        squaredNorm += value * value;
    const norm = Math.sqrt(squaredNorm);
    if (!Number.isFinite(norm) || norm === 0)
        throw new Error('Invalid CLIP embedding norm');
    return Float32Array.from(values, (value) => value / norm);
}

async function initialize()
{
    if (!initialization)
        initialization = (async () =>
        {
            tokenizer = await AutoTokenizer.from_pretrained(MODEL);
            textModel = await CLIPTextModelWithProjection.from_pretrained(MODEL, { dtype: 'fp32' });
            const prompts = [...UNSAFE_PROMPTS, ...SAFE_PROMPTS];
            const output = await textModel(await tokenizer(prompts, { padding: true, truncation: true }));
            if (output.text_embeds.dims.at(-1) !== DIMENSIONS || output.text_embeds.dims[0] !== prompts.length)
                throw new Error('Unexpected CLIP text embedding dimensions');
            promptVectors = prompts.map((_, row) => output.text_embeds.data.slice(row * DIMENSIONS, (row + 1) * DIMENSIONS));
        })();
    await initialization;
}

export async function textVectors(texts)
{
    if (!Array.isArray(texts) || texts.length === 0)
        return [];
    await initialize();
    const output = await textModel(await tokenizer(texts, { padding: true, truncation: true }));
    if (output.text_embeds.dims.at(-1) !== DIMENSIONS || output.text_embeds.dims[0] !== texts.length)
        throw new Error('Unexpected CLIP text embedding dimensions');
    return texts.map((_, row) => normalized(output.text_embeds.data.slice(row * DIMENSIONS, (row + 1) * DIMENSIONS)));
}

export async function textVector(text)
{
    const [vector] = await textVectors([String(text ?? '')]);
    return vector;
}

export async function clipUnsafe(vector)
{
    await initialize();
    if (vector.length !== DIMENSIONS)
        throw new Error(`Expected a ${DIMENSIONS}-dimension CLIP vector`);
    const logits = promptVectors.map((prompt) =>
    {
        let dot = 0;
        let squaredNorm = 0;
        for (let index = 0; index < DIMENSIONS; index++)
        {
            dot += prompt[index] * vector[index];
            squaredNorm += prompt[index] * prompt[index];
        }
        return CLIP_LOGIT_SCALE * dot / Math.sqrt(squaredNorm);
    });
    const max = Math.max(...logits);
    const weights = logits.map((logit) => Math.exp(logit - max));
    const unsafe = weights.slice(0, UNSAFE_PROMPTS.length).reduce((sum, weight) => sum + weight, 0);
    return Number((unsafe / weights.reduce((sum, weight) => sum + weight, 0)).toFixed(4));
}
