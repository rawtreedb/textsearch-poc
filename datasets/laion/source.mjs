import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { DATA_DIR } from '../../lib/loader.mjs';

const BASE = 'https://deploy.laion.ai/8f83b608504d46bb81708ec86e912220/embeddings';
export const METADATA_COLUMNS = ['caption', 'NSFW', 'similarity', 'LICENSE', 'url', 'status', 'original_width', 'original_height'];

const shardPaths = (shard) => ({
    metadata: `${DATA_DIR}/laion-metadata-${shard}.parquet`,
    embeddings: `${DATA_DIR}/laion-embeddings-${shard}.npy`,
});

async function download(url, path)
{
    try
    {
        if ((await stat(path)).size > 0)
            return;
    }
    catch {}

    const temporary = `${path}.part`;
    await unlink(temporary).catch(() => {});
    const response = await fetch(url);
    if (!response.ok || !response.body)
        throw new Error(`Download ${url}: HTTP ${response.status}`);
    try
    {
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
        if ((await stat(temporary)).size === 0)
            throw new Error(`Download ${url}: empty response`);
        await rename(temporary, path);
    }
    catch (error)
    {
        await unlink(temporary).catch(() => {});
        throw error;
    }
}

export async function downloadShard(shard)
{
    await mkdir(DATA_DIR, { recursive: true });
    const paths = shardPaths(shard);
    await download(`${BASE}/metadata/metadata_${shard}.parquet`, paths.metadata);
    await download(`${BASE}/img_emb/img_emb_${shard}.npy`, paths.embeddings);
    return paths;
}

export async function readMetadata(path)
{
    const file = await asyncBufferFromFile(path);
    return parquetReadObjects({ file, columns: METADATA_COLUMNS, rowFormat: 'object', compressors });
}

export async function openVectors(path)
{
    const handle = await open(path, 'r');
    try
    {
        const fixed = Buffer.alloc(12);
        const { bytesRead } = await handle.read(fixed, 0, fixed.length, 0);
        if (bytesRead < 10 || fixed.subarray(0, 6).toString('binary') !== '\x93NUMPY')
            throw new Error(`Invalid NPY file: ${path}`);
        const major = fixed[6];
        const headerLength = major === 1 ? fixed.readUInt16LE(8) : fixed.readUInt32LE(8);
        const headerStart = major === 1 ? 10 : 12;
        const headerBytes = Buffer.alloc(headerLength);
        const headerRead = await handle.read(headerBytes, 0, headerLength, headerStart);
        if (headerRead.bytesRead !== headerLength)
            throw new Error(`Truncated NPY header: ${path}`);
        const header = headerBytes.toString('ascii');
        const dtype = /'descr'\s*:\s*'([^']+)'/.exec(header)?.[1];
        const shapeMatch = /'shape'\s*:\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(header);
        if (dtype !== '<f2' && dtype !== '=f2')
            throw new Error(`Expected little-endian float16 in ${path}, got ${dtype}`);
        if (/fortran_order'\s*:\s*True/.test(header))
            throw new Error(`Expected C-order NPY data in ${path}`);
        if (!shapeMatch)
            throw new Error(`Could not read NPY matrix shape from ${path}`);
        const rows = Number(shapeMatch[1]);
        const dimensions = Number(shapeMatch[2]);
        const dataOffset = headerStart + headerLength;
        return {
            rows,
            dimensions,
            async readRows(start, count)
            {
                if (start < 0 || count < 0 || start + count > rows)
                    throw new RangeError(`NPY row range ${start}:${start + count} exceeds ${rows}`);
                const bytes = Buffer.allocUnsafe(count * dimensions * 2);
                const expected = bytes.length;
                let read = 0;
                while (read < expected)
                {
                    const result = await handle.read(bytes, read, expected - read, dataOffset + start * dimensions * 2 + read);
                    if (result.bytesRead === 0)
                        throw new Error(`Truncated NPY data in ${path}`);
                    read += result.bytesRead;
                }
                return bytes;
            },
            close: () => handle.close(),
        };
    }
    catch (error)
    {
        await handle.close();
        throw error;
    }
}

export function normalizedHalfVector(bytes, row, dimensions)
{
    const vector = new Float32Array(dimensions);
    const start = row * dimensions * 2;
    let squaredNorm = 0;
    for (let index = 0; index < dimensions; index++)
    {
        const bits = bytes.readUInt16LE(start + index * 2);
        const sign = bits & 0x8000 ? -1 : 1;
        const exponent = bits & 0x7c00;
        const fraction = bits & 0x03ff;
        const value = exponent === 0
            ? sign * fraction * 5.960464477539063e-8
            : exponent === 0x7c00
                ? fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY
                : sign * (1024 + fraction) * 2 ** ((exponent >> 10) - 25);
        vector[index] = value;
        squaredNorm += value * value;
    }
    const norm = Math.sqrt(squaredNorm);
    if (!Number.isFinite(norm) || norm === 0)
        throw new Error('Invalid LAION image embedding norm');
    for (let index = 0; index < dimensions; index++)
        vector[index] /= norm;
    return vector;
}
