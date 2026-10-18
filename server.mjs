#!/usr/bin/env node
// Serves the landing page and one search UI + API per dataset under /<dataset>/ and /api/<dataset>/<route>.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const DATASET_IDS = (process.env.DATASETS ?? 'wikipedia,stackoverflow').split(',').map((s) => s.trim()).filter(Boolean);

// Each dataset module default-exports { id, title, description, routes: { name: async (URLSearchParams) => json } }.
const datasets = new Map();
for (const id of DATASET_IDS)
{
    if (!/^[a-z0-9-]+$/.test(id))
        throw new Error(`Invalid dataset id: ${id}`);
    const { default: dataset } = await import(`./datasets/${id}/api.mjs`);
    datasets.set(id, dataset);
}

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

function send(res, status, body, type = 'application/json')
{
    res.writeHead(status, { 'content-type': type, 'cache-control': type === 'application/json' ? 'no-store' : 'public, max-age=300' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function sendFile(res, root, relative)
{
    const path = normalize(join(root, relative));
    if (!path.startsWith(root + '/'))
        return send(res, 404, { error: 'not found' });
    try
    {
        return send(res, 200, await readFile(path), TYPES[extname(path)] ?? 'application/octet-stream');
    }
    catch (error)
    {
        if (error.code === 'ENOENT' || error.code === 'EISDIR')
            return send(res, 404, { error: 'not found' });
        throw error;
    }
}

createServer(async (req, res) =>
{
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    try
    {
        if (url.pathname === '/healthz')
            return send(res, 200, { ok: true });
        if (url.pathname === '/api/datasets')
            return send(res, 200, [...datasets.values()].map(({ id, title, description }) => ({ id, title, description, path: `/${id}/` })));
        if (parts[0] === 'api' && parts.length === 3)
        {
            const handler = datasets.get(parts[1])?.routes?.[parts[2]];
            if (!handler || req.method !== 'GET')
                return send(res, 404, { error: 'not found' });
            return send(res, 200, await handler(url.searchParams));
        }
        if (parts.length === 0)
            return sendFile(res, join(here, 'public'), 'index.html');
        if (parts[0] === 'common')
            return sendFile(res, join(here, 'public', 'common'), parts.slice(1).join('/'));
        if (datasets.has(parts[0]))
        {
            if (parts.length === 1 && !url.pathname.endsWith('/'))
            {
                res.writeHead(301, { location: `/${parts[0]}/${url.search}` });
                return res.end();
            }
            return sendFile(res, join(here, 'datasets', parts[0], 'public'), parts.slice(1).join('/') || 'index.html');
        }
        return sendFile(res, join(here, 'public'), parts.join('/'));
    }
    catch (error)
    {
        console.error(`[web] ${req.method} ${url.pathname}: ${error.message}`);
        return send(res, error.status && error.status < 500 ? error.status : 502, { error: error.message, hint: error.hint });
    }
}).listen(PORT, () => console.log(`[web] listening on :${PORT} (datasets: ${[...datasets.keys()].join(', ')})`));
