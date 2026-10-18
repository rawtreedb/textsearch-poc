import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { DATA_DIR, doneSet, log, retry } from '../../lib/loader.mjs';
import { ensureIndexes } from '../../lib/text_import.mjs';
import { insert } from '../../lib/rawtree.mjs';
import { parseLog } from './parser.mjs';

const TABLE = 'loghub_lines';
const BATCH = 50_000;
const REQUEST_HEADERS = { 'User-Agent': 'curl/8.5.0' };
const EXPECTED = {
    HDFS_v1: 11175629, HDFS_v2: 71118073, HDFS_v3_TraceBench: 14778079, Hadoop: 394308, Spark: 33236604,
    Zookeeper: 74380, OpenStack: 207820, BGL: 4747963, HPC: 433489, Thunderbird: 211212192, Windows: 114608388,
    Linux: 25567, Mac: 117283, Android_v1: 1555005, Android_v2: 30348042, HealthApp: 253395, Apache: 56481, SSH: 655146, Proxifier: 21329,
};
const done = doneSet(TABLE);
const indexes = [{ name: 'idx_message', expression: 'lowerUTF8(__raw_data.message::String)' }];
const dir = path.join(DATA_DIR, 'loghub');
await mkdir(dir, { recursive: true });

async function download(file, target)
{
    try { if ((await stat(target)).size === file.size) return; } catch {}
    const partial = `${target}.part`;
    const response = await fetch(file.links.self, { headers: REQUEST_HEADERS });
    if (!response.ok || !response.body) throw new Error(`Download ${file.key}: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    if ((await stat(partial)).size !== file.size) throw new Error(`${file.key}: downloaded size mismatch`);
    await rename(partial, target);
}

function entries(file)
{
    if (file.endsWith('.zip'))
        return execFileSync('unzip', ['-Z1', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
    return execFileSync('tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
}

function logStream(archive, file, entry)
{
    const child = archive.endsWith('.zip')
        ? spawn('unzip', ['-p', file, entry], { stdio: ['ignore', 'pipe', 'inherit'] })
        : spawn('tar', ['-xzOf', file, '--', entry], { stdio: ['ignore', 'pipe', 'inherit'] });
    return { child, stream: child.stdout };
}

async function loadEntry(archive, archivePath, entry, system)
{
    const unit = `${archive}:${entry}`;
    if (done.has(unit)) return { skipped: false, done: true };
    const { child, stream } = logStream(archive, archivePath, entry);
    const exitPromise = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
    });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNo = 0, parsed = 0, unparsed = 0, batchNo = 0, batch = [];
    const flush = async () => {
        if (!batch.length) return;
        await insert(TABLE, batch, { dedupToken: `loghub-${archive}-${entry}-${batchNo++}` });
        if (batchNo === 1) await ensureIndexes(TABLE, indexes, done);
        batch = [];
    };
    for await (const raw of reader)
    {
        lineNo++;
        const line = raw.replace(/\0/g, '').replace(/^\uFEFF/, '');
        const fields = parseLog(system, line);
        if (fields) parsed++; else unparsed++;
        batch.push({ system, file: entry, line_no: lineNo, ...(fields ?? { ts: null, level: null, component: null, message: line, label: null }) });
        if (batch.length >= BATCH) await flush();
    }
    await flush();
    const exit = await exitPromise;
    if (exit !== 0) throw new Error(`${archive}:${entry}: extractor exited ${exit}`);
    done.add(unit);
    log('entry-complete', archive, entry, `rows=${lineNo}`, `parsed=${parsed}`, `unparsed=${unparsed}`);
    return { rows: lineNo, parsed, unparsed };
}

const response = await fetch('https://zenodo.org/api/records/8196385', { headers: REQUEST_HEADERS });
if (!response.ok) throw new Error(`Zenodo record request failed: HTTP ${response.status}`);
const record = await response.json();
const archives = record.files.filter((f) => Object.hasOwn(EXPECTED, path.basename(f.key).replace(/\.(zip|tar\.gz)$/, '')))
    .sort((a, b) => a.size - b.size);
if (archives.length !== 19) throw new Error(`Expected 19 Loghub archives, got ${archives.length}`);

for (const file of archives)
{
    const archive = path.basename(file.key);
    const system = archive.replace(/\.(zip|tar\.gz)$/, '');
    const archiveDone = `${archive}:__archive__`;
    if (done.has(archiveDone)) continue;
    const archivePath = path.join(dir, archive);
    await retry(() => download(file, archivePath), `download ${archive}`);
    let rows = 0, parsed = 0, unparsed = 0;
    for (const entry of entries(archivePath))
    {
        if (entry.endsWith('/') || /(^|\/)(readme|.*label.*|.*template.*|.*structured.*|.*event.*)\b/i.test(entry) || !/\.(log|txt)$/i.test(entry))
        {
            log('entry-skipped', archive, entry);
            done.add(`${archive}:${entry}`);
            continue;
        }
        const result = await loadEntry(archive, archivePath, entry, system);
        rows += result.rows ?? 0; parsed += result.parsed ?? 0; unparsed += result.unparsed ?? 0;
    }
    done.add(archiveDone);
    await unlink(archivePath);
    log('archive-complete', system, `expected=${EXPECTED[system]}`, `inserted=${rows}`, `parsed=${parsed}`, `unparsed=${unparsed}`);
}
