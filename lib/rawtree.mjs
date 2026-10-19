// Minimal RawTree HTTP API client shared by the server and the loaders.
const API = process.env.RAWTREE_API_URL ?? 'https://api.rawtree.com';
export const DATABASE = process.env.RAWTREE_DATABASE ?? 'default';
const USER_AGENT = 'textsearch-poc';

const writeKey = () => process.env.RAWTREE_API_KEY;
const queryKey = () => process.env.RAWTREE_QUERY_API_KEY || process.env.RAWTREE_API_KEY;

export class RawTreeError extends Error
{
    constructor(message, { status, code, hint } = {})
    {
        super(message);
        this.status = status;
        this.code = code;
        this.hint = hint;
    }
}

async function request(path, { key, method = 'POST', body, search = {} } = {})
{
    if (!key)
        throw new RawTreeError('Set RAWTREE_API_KEY (and optionally RAWTREE_QUERY_API_KEY for a read-only key)');
    const url = new URL(path, API);
    url.searchParams.set('database', DATABASE);
    for (const [name, value] of Object.entries(search))
        if (value !== undefined)
            url.searchParams.set(name, String(value));
    const response = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': USER_AGENT },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; }
    catch { parsed = { message: text }; }
    if (!response.ok)
        throw new RawTreeError(parsed.message ?? `RawTree HTTP ${response.status}`, { status: response.status, code: parsed.code ?? parsed.error, hint: parsed.hint });
    return parsed;
}

// Runs a read-only query. `displaySql` is what the UI shows (e.g. without long literal arrays).
export async function query(sql, { displaySql = sql, queryId } = {})
{
    const body = await request('/v1/query', { key: queryKey(), body: { sql, format: 'JSON', ...(queryId ? { query_id: queryId } : {}) } });
    return { data: body.data, rows: body.rows, meta: body.meta, statistics: body.statistics, hints: body.hints, sql: displaySql };
}

export async function execute(sql)
{
    return request('/v1/query', { key: writeKey(), body: { sql, format: 'JSON' } });
}

export async function listTables()
{
    return request('/v1/tables', { key: queryKey(), method: 'GET' });
}

export async function describeTable(name)
{
    return request(`/v1/tables/${encodeURIComponent(name)}`, { key: queryKey(), method: 'GET' });
}

// Inserts an array of JSON objects. The table is created on first insert if it does not exist.
export async function insert(table, rows, { retries = 5, dedupToken } = {})
{
    for (let attempt = 0; ; attempt++)
    {
        try
        {
            return await request(`/v1/tables/${encodeURIComponent(table)}`, {
                key: writeKey(),
                body: rows,
                search: dedupToken ? { deduplicate_insert: 'enable', insert_deduplication_token: dedupToken } : {},
            });
        }
        catch (error)
        {
            const retryable = error.status === undefined || error.status === 429 || error.status >= 500;
            if (!retryable || attempt >= retries)
                throw error;
            await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1000 * 2 ** attempt)));
        }
    }
}

// Server-side import of a public URL (ClickHouse `url()` without redirects; the format comes from the extension).
// URL mode streams NDJSON progress lines; returns the last one, e.g. `{"inserted":123}`.
export async function insertFromUrl(table, sourceUrl, { dedupToken } = {})
{
    const url = new URL(`/v1/tables/${encodeURIComponent(table)}`, API);
    url.searchParams.set('database', DATABASE);
    url.searchParams.set('url', sourceUrl);
    if (dedupToken)
    {
        url.searchParams.set('deduplicate_insert', 'enable');
        url.searchParams.set('insert_deduplication_token', dedupToken);
        if (await insertRunning(dedupToken))
            return waitForInsert(dedupToken);
    }
    let error;
    try
    {
        const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${writeKey()}`, 'user-agent': USER_AGENT } });
        const lines = (await response.text()).trim().split('\n');
        let last;
        try { last = JSON.parse(lines.at(-1)); }
        catch { last = { message: lines.at(-1) }; }
        if (response.ok && !last.error)
            return last;
        error = new RawTreeError(last.message ?? `RawTree HTTP ${response.status}`, { status: response.status, code: last.error, hint: last.hint });
    }
    catch (e) { error = e; }
    if (dedupToken && await insertRunning(dedupToken))
        return waitForInsert(dedupToken);
    throw error;
}

// The API can drop a long url() import (timeouts after ~5 min) while the INSERT keeps running on the server,
// and INSERT ... SELECT FROM url() is not deduplicated, so a blind retry would load the file twice.
// Instead, find the server-side INSERT by its dedup token, wait for it and return its outcome.
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls until the query succeeds: a failed status check must not turn into a re-sent INSERT.
async function poll(sql)
{
    for (;;)
    {
        try { return (await query(sql)).data; }
        catch (error) { log(`poll: ${error.message}`); await sleep(15_000); }
    }
}

async function insertRunning(token)
{
    return (await runningInserts(token)).n > 0;
}

async function runningInserts(token)
{
    const [row] = await poll(`SELECT count() AS n, toUnixTimestamp(now()) AS now FROM clusterAllReplicas(default, system.processes) WHERE query_kind = 'Insert' AND Settings['insert_deduplication_token'] = ${literal(token)}`);
    return { n: Number(row.n), now: Number(row.now) };
}

async function lastInsert(token, minutes, since)
{
    const [row] = await poll(`SELECT type, written_rows, exception FROM clusterAllReplicas(default, system.query_log)
        WHERE event_date >= yesterday() AND event_time > now() - INTERVAL ${Number(minutes)} MINUTE AND event_time >= toDateTime(${Number(since)}) AND type != 'QueryStart' AND query_kind = 'Insert'
          AND Settings['insert_deduplication_token'] = ${literal(token)}
        ORDER BY event_time_microseconds DESC LIMIT 1`);
    return row;
}

// Only a query_log entry written after we saw the INSERT running can be its outcome.
async function waitForInsert(token)
{
    const { now: since } = await runningInserts(token);
    while (await insertRunning(token))
        await sleep(15_000);
    for (let attempt = 0; attempt < 40; attempt++, await sleep(15_000))
    {
        const row = await lastInsert(token, 30, since);
        if (!row)
            continue;
        if (row.type !== 'QueryFinish')
            throw new RawTreeError(row.exception);
        return { inserted: Number(row.written_rows), waited: true };
    }
    throw new RawTreeError(`No query_log entry for insert ${token}`);
}

// Creates an empty table with an explicit sorting key. Ignores "already exists".
export async function createTable(name, sortingKey)
{
    try
    {
        return await request('/v1/tables', { key: writeKey(), body: { name, sorting_key: sortingKey ?? null } });
    }
    catch (error)
    {
        if (error.status === 409 || /already exists/i.test(error.message))
            return { exists: true };
        throw error;
    }
}

export function isMissingTable(error)
{
    return error.code === 'UNKNOWN_TABLE' || /^Table \S+ not found\.?$/.test(error.message) || /UNKNOWN_TABLE|doesn't exist/.test(error.message);
}

// Single-quoted SQL string literal.
export const literal = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export const identifier = (s) =>
{
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s))
        throw new Error(`Invalid identifier: ${s}`);
    return s;
};
