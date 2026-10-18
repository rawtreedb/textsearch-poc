import { basename } from 'node:path';
import { textVectors } from '../../lib/clip.mjs';
import { log } from '../../lib/loader.mjs';
import { downloadShard, normalizedHalfVector, openVectors, readMetadata } from './source.mjs';

const SAMPLE_SIZE = 200;
const SHARD = 0;
const DIMENSIONS = 512;
const { metadata: metadataPath, embeddings: embeddingsPath } = await downloadShard(SHARD);
log('read metadata', basename(metadataPath));
const rows = await readMetadata(metadataPath);
const vectors = await openVectors(embeddingsPath);
if (rows.length !== vectors.rows || vectors.dimensions !== DIMENSIONS)
    throw new Error(`Alignment dimensions differ: metadata=${rows.length}, embeddings=${vectors.rows}x${vectors.dimensions}`);

let seed = 0x400e;
const random = () =>
{
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
};
const samples = new Set();
while (samples.size < SAMPLE_SIZE)
{
    const index = Math.floor(random() * (rows.length - 1));
    if (typeof rows[index].caption === 'string' && rows[index].caption.trim() && Number.isFinite(Number(rows[index].similarity)))
        samples.add(index);
}
const indices = [...samples].sort((a, b) => a - b);
const aligned = [];
const shifted = [];
for (let offset = 0; offset < indices.length; offset += 32)
{
    const chunk = indices.slice(offset, offset + 32);
    const first = chunk[0];
    const last = chunk.at(-1);
    const bytes = await vectors.readRows(first, last - first + 2);
    const texts = await textVectors(chunk.map((index) => rows[index].caption));
    for (let index = 0; index < chunk.length; index++)
    {
        const imageOffset = chunk[index] - first;
        const expected = Number(rows[chunk[index]].similarity);
        const alignedImage = normalizedHalfVector(bytes, imageOffset, vectors.dimensions);
        const shiftedImage = normalizedHalfVector(bytes, imageOffset + 1, vectors.dimensions);
        let alignedCosine = 0;
        let shiftedCosine = 0;
        for (let dimension = 0; dimension < vectors.dimensions; dimension++)
        {
            alignedCosine += texts[index][dimension] * alignedImage[dimension];
            shiftedCosine += texts[index][dimension] * shiftedImage[dimension];
        }
        aligned.push({ actual: alignedCosine, expected });
        shifted.push({ actual: shiftedCosine, expected });
    }
}
await vectors.close();

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
function metrics(observations)
{
    const meanAbsoluteDifference = mean(observations.map(({ actual, expected }) => Math.abs(actual - expected)));
    const actualMean = mean(observations.map(({ actual }) => actual));
    const expectedMean = mean(observations.map(({ expected }) => expected));
    let covariance = 0;
    let actualVariance = 0;
    let expectedVariance = 0;
    for (const { actual, expected } of observations)
    {
        covariance += (actual - actualMean) * (expected - expectedMean);
        actualVariance += (actual - actualMean) ** 2;
        expectedVariance += (expected - expectedMean) ** 2;
    }
    return {
        mean_abs_diff: meanAbsoluteDifference,
        correlation: covariance / Math.sqrt(actualVariance * expectedVariance),
    };
}
const alignedStats = metrics(aligned);
const shiftedStats = metrics(shifted);
log('alignment', JSON.stringify({ samples: aligned.length, aligned: alignedStats, shifted_by_one: shiftedStats }));
if (alignedStats.mean_abs_diff >= 0.03 || shiftedStats.mean_abs_diff <= 0.1)
    process.exitCode = 1;
