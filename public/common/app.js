// Shared search + analytics UI. A dataset page sets `window.APP = { api, filters, examples }` before loading this script.
// filters: [{ name, label, options: [[value, label], ...] } | { name, label, placeholder, type }]
const { api, filters = [], examples = [] } = window.APP;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => (typeof n === 'number' || /^-?\d+(\.\d+)?$/.test(String(n)) ? Number(n).toLocaleString('en-US') : esc(n));
const COLORS = ['#0c47f3', '#02b078', '#f59e0b', '#e11d48', '#7c3aed', '#0891b2', '#a8a29e'];
let tab = 'results';

function renderForm()
{
    const controls = [
        `<input type="search" name="q" placeholder="Search…" required autofocus>`,
        `<select name="mode"><option value="all">all words</option><option value="any">any word</option><option value="phrase">phrase</option></select>`,
        ...filters.map((f) => f.options
            ? `<select name="${f.name}" title="${esc(f.label)}">${f.options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`
            : `<input class="small" name="${f.name}" type="${f.type ?? 'text'}" placeholder="${esc(f.placeholder ?? f.label)}" title="${esc(f.label)}">`),
        `<button>Search</button>`,
    ];
    $('form').innerHTML = controls.join('');
    $('examples').innerHTML = examples.length ? `Try:${examples.map((e) => `<a data-q="${esc(new URLSearchParams(e).toString())}">${esc(e.q)}${e.mode === 'phrase' ? ' (phrase)' : ''}</a>`).join('')}` : '';
    $('examples').onclick = (event) =>
    {
        const q = event.target.dataset?.q;
        if (q === undefined)
            return;
        readState(new URLSearchParams(q));
        run(true);
    };
    $('form').onsubmit = (event) => { event.preventDefault(); run(true); };
    for (const name of ['results', 'analytics'])
        $(`tab-${name}`).onclick = () => { tab = name; renderTabs(); run(true); };
}

const params = () => new URLSearchParams([...new FormData($('form'))].filter(([, v]) => v !== ''));

function readState(search)
{
    for (const element of $('form').elements)
        if (element.name)
            element.value = search.get(element.name) ?? (element.tagName === 'SELECT' ? element.options[0].value : '');
    if (search.get('tab'))
        tab = search.get('tab') === 'analytics' ? 'analytics' : 'results';
    renderTabs();
}

function renderTabs()
{
    for (const name of ['results', 'analytics'])
        $(`tab-${name}`).classList.toggle('active', tab === name);
}

function highlight(text, tokens)
{
    let html = esc(text);
    for (const t of tokens)
        html = html.replace(new RegExp(`(?<![\\p{L}\\p{N}])(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\p{L}\\p{N}])`, 'giu'), '<mark>$1</mark>');
    return html;
}

function stats(result)
{
    const s = result?.statistics;
    return s ? `${(s.elapsed * 1000).toFixed(0)} ms · ${num(s.rows_read)} rows · ${(s.bytes_read / 1e6).toFixed(1)} MB read` : '';
}

const queryDetails = (result, title = 'SQL sent to RawTree') =>
    `<details class="query"><summary>${esc(title)} <span class="stats">${stats(result)}</span></summary><pre class="sql">${esc(result?.sql ?? '')}</pre></details>`;

// rows: [{ bucket, series, value }] -> stacked columns.
function stackChart(rows)
{
    if (!rows?.length)
        return '<p class="muted">No data.</p>';
    const buckets = [...new Set(rows.map((r) => r.bucket))].sort();
    const totals = new Map();
    for (const r of rows)
        totals.set(r.series, (totals.get(r.series) ?? 0) + Number(r.value));
    const series = [...totals.keys()].sort((a, b) => (a === 'other') - (b === 'other') || totals.get(b) - totals.get(a));
    const color = new Map(series.map((s, i) => [s, s === 'other' ? COLORS.at(-1) : COLORS[i % (COLORS.length - 1)]]));
    const byBucket = new Map(buckets.map((b) => [b, []]));
    for (const r of rows)
        byBucket.get(r.bucket).push(r);
    const max = Math.max(...[...byBucket.values()].map((list) => list.reduce((sum, r) => sum + Number(r.value), 0)), 1);
    const w = 600 / buckets.length;
    let bars = '';
    buckets.forEach((b, i) =>
    {
        let y = 200;
        for (const r of byBucket.get(b).sort((x, z) => series.indexOf(x.series) - series.indexOf(z.series)))
        {
            const h = Number(r.value) / max * 195;
            y -= h;
            bars += `<rect x="${(i * w).toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(w - 0.5, 0.5).toFixed(2)}" height="${h.toFixed(2)}" fill="${color.get(r.series)}"><title>${esc(b)} · ${esc(r.series)}: ${num(r.value)}</title></rect>`;
        }
    });
    return `<svg class="stack" viewBox="0 0 600 200" preserveAspectRatio="none">${bars}</svg>
<div class="axis"><span>${esc(buckets[0])}</span><span>${esc(buckets.at(-1))}</span></div>
<div class="legend">${series.map((s) => `<span><i style="background:${color.get(s)}"></i>${esc(s)}</span>`).join('')}</div>`;
}

// rows: [{ label, value }] -> horizontal bars.
function barChart(rows)
{
    if (!rows?.length)
        return '<p class="muted">No data.</p>';
    const max = Math.max(...rows.map((r) => Number(r.value)), 1);
    return rows.map((r) => `<div class="bar"><span title="${esc(r.label)}">${esc(r.label)}</span><div><div class="fill" style="width:${Number(r.value) / max * 100}%"></div></div><b>${num(r.value)}</b></div>`).join('');
}

const kvTable = (row) => row ? `<table class="kv">${Object.entries(row).map(([k, v]) => `<tr><td>${esc(k.replaceAll('_', ' '))}</td><td>${num(v)}</td></tr>`).join('')}</table>` : '<p class="muted">No data.</p>';

function renderPanel(p)
{
    const body = p.error ? `<p class="error">${esc(p.error)}</p>`
        : p.kind === 'stack' ? stackChart(p.result.data)
        : p.kind === 'bars' ? barChart(p.result.data)
        : kvTable(p.result.data[0]);
    return `<div class="card${p.wide ? ' wide' : ''}"><h3>${esc(p.title)}</h3>${body}${p.result ? queryDetails(p.result, 'SQL') : ''}</div>`;
}

async function fetchJson(path)
{
    const response = await fetch(path);
    const body = await response.json();
    if (!response.ok)
        throw new Error(body.error ?? `HTTP ${response.status}`);
    return body;
}

let generation = 0;
async function run(push = false)
{
    const search = params();
    if (!search.get('q'))
        return;
    const url = new URLSearchParams(search);
    if (tab === 'analytics')
        url.set('tab', 'analytics');
    if (push)
        history.pushState(null, '', `?${url}`);
    const current = ++generation;
    $('summary').textContent = 'Searching…';
    $('output').innerHTML = '';
    const started = performance.now();
    try
    {
        if (tab === 'analytics')
        {
            const r = await fetchJson(`${api}/analytics?${search}`);
            if (current !== generation)
                return;
            $('summary').textContent = `Analytics in ${((performance.now() - started) / 1000).toFixed(2)} s`;
            $('output').innerHTML = `<div class="panels">${r.panels.map(renderPanel).join('')}</div>`;
            return;
        }
        const r = await fetchJson(`${api}/search?${search}`);
        if (current !== generation)
            return;
        $('summary').textContent = `${num(r.total)} matches · showing ${r.hits.length} · ${((performance.now() - started) / 1000).toFixed(2)} s`;
        const hits = r.hits.map((h) => `<div class="hit">
<a class="title" href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a>
<div class="snippet">…${highlight(h.snippet, r.tokens)}…</div>
<div class="meta">${h.meta.map((m) => `<span>${esc(m)}</span>`).join('')}${(h.tags ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
</div>`).join('') || '<p class="muted">No matches.</p>';
        $('output').innerHTML = `<div class="layout"><div class="card">${hits}</div><div>
${renderPanel(r.timeline)}
<div class="card" style="margin-top:16px"><h3>Queries</h3>${r.queries.map((q) => queryDetails(q, q.title)).join('')}</div>
</div></div>`;
    }
    catch (error)
    {
        if (current === generation)
            $('summary').innerHTML = `<span class="error">${esc(error.message)}</span>`;
    }
}

renderForm();
readState(new URLSearchParams(location.search));
window.onpopstate = () => { readState(new URLSearchParams(location.search)); run(); };
fetchJson(`${api}/stats`).then((s) => { $('stats').innerHTML = kvTable(s); }).catch(() => {});
run();
