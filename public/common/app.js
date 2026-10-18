// Shared search + analytics UI (styled after bluesky-fulltext-poc). A dataset page sets `window.APP` before loading this script:
// { id, api, title, eyebrow, lead, placeholder, stats: [[key, label, kind?]], filters, examples }
// filters: [{ name, label, options: [[value, label], ...] } | { name, label, placeholder, type }]
const APP = window.APP;
const { api, filters = [], examples = [] } = APP;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n) => (typeof n === 'number' || /^-?\d+(\.\d+)?$/.test(String(n)) ? Number(n).toLocaleString('en-US') : esc(n));
const compact = (n) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(n));
const bytes = (n) => { const units = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; n = Number(n); while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; } return `${n.toFixed(i ? 1 : 0)} ${units[i]}`; };
const COLORS = ['#0c47f3', '#02b078', '#ee9a48', '#e11d48', '#7c3aed', '#0891b2', '#a8a29e'];
const DEFAULT_DATASETS = [
    { id: 'wikipedia', title: 'Wikipedia', path: '/wikipedia/' },
    { id: 'stackoverflow', title: 'Stack Overflow', path: '/stackoverflow/' },
];
let datasets = DEFAULT_DATASETS;
const REPO = 'https://github.com/rawtreedb/textsearch-poc';
let tab = 'results';
let queries = [];
let queryIndex = 0;

function renderNav()
{
    const nav = document.querySelector('header nav');
    const links = datasets.map(({ id, title, path }) => `<a class="pill${id === APP.id ? ' active' : ''}" href="${esc(path)}">${esc(title)}</a>`).join('');
    nav.innerHTML = `<div class="dataset-pills">${links}</div><a class="pill ext" href="${REPO}" target="_blank" rel="noopener">Download this repo</a><a class="pill primary" href="https://rawtree.com/waitlist" target="_blank" rel="noopener">Request access</a>`;
}

function renderShell()
{
    document.body.innerHTML = `
<header><div class="wrap">
  <a class="brand" href="/"><span class="logo" aria-hidden="true"></span>RawTree</a>
  <nav></nav>
</div></header>
<section class="hero wrap">
  <div class="eyebrow"><span class="dot"></span>${esc(APP.eyebrow)}</div>
  <h1>${esc(APP.title)}</h1>
  <p class="lead">${esc(APP.lead)}</p>
  <div class="stats" id="stats">${(APP.stats ?? []).map(([, label]) => `<div class="stat"><div class="v">–</div><div class="k">${esc(label)}</div></div>`).join('')}</div>
</section>
<section class="wrap">
  <form id="f"></form>
  <div class="examples" id="examples"></div>
  <div class="search-tabs" role="tablist" aria-label="View">
    <button type="button" id="tab-results">Results</button><button type="button" id="tab-analytics">Analytics</button>
  </div>
</section>
<main class="wrap" id="main">
  <section>
    <div class="meta" id="meta"></div>
    <details class="spoiler" id="under">
      <summary><span class="chev"></span>Show RawTree queries</summary>
      <div class="code under">
        <div class="bar"><i></i><i></i><i></i><div class="tabs" id="qtabs"></div><span class="qstat" id="qstat"></span><button type="button" class="act" id="copy">Copy</button></div>
        <pre id="sql"></pre>
      </div>
    </details>
    <div id="hits"></div>
  </section>
  <aside id="aside"></aside>
</main>
<footer><div class="wrap"><span>Data: ${esc(APP.source)}</span><span>Storage &amp; search: <a href="https://rawtree.com" target="_blank" rel="noopener">RawTree</a></span><span>Source: <a href="${REPO}" target="_blank" rel="noopener">github.com/rawtreedb/textsearch-poc</a></span></div></footer>`;
    renderNav();
}

function renderForm()
{
    const modes = APP.modes ?? [['all', 'All words'], ['any', 'Any word'], ['phrase', 'Exact phrase']];
    $('f').innerHTML = [
        `<input type="search" name="q" placeholder="${esc(APP.placeholder ?? 'Search…')}" required autofocus>`,
        `<select name="mode" title="Match mode">${modes.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`,
        ...(APP.results === 'images' ? ['<input type="hidden" name="similar">'] : []),
        ...filters.map((f) => f.options
            ? `<select name="${f.name}" title="${esc(f.label)}">${f.options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`
            : `<input class="small" name="${f.name}" type="${f.type ?? 'text'}" placeholder="${esc(f.placeholder ?? f.label)}" title="${esc(f.label)}">`),
        `<button class="pill primary">Search</button>`,
    ].join('');
    $('examples').innerHTML = examples.length ? `Try${examples.map((e) => `<a data-q="${esc(new URLSearchParams(e).toString())}">${esc(e.mode === 'phrase' ? `"${e.q}"` : e.q)}</a>`).join('')}` : '';
    $('examples').onclick = (event) =>
    {
        const q = event.target.dataset?.q;
        if (q === undefined)
            return;
        readState(new URLSearchParams(q));
        run(true);
    };
    $('f').onsubmit = (event) =>
    {
        event.preventDefault();
        const similar = $('f').elements.namedItem('similar');
        if (similar)
            similar.value = '';
        run(true);
    };
    for (const name of ['results', 'analytics'])
        $(`tab-${name}`).onclick = () => { tab = name; renderTabs(); run(true); };
    $('copy').onclick = () => navigator.clipboard?.writeText(queries[queryIndex]?.sql ?? '');
}

const params = () => new URLSearchParams([...new FormData($('f'))].filter(([, v]) => v !== ''));

function readState(search)
{
    for (const element of $('f').elements)
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
    document.body.classList.toggle('analytics-mode', tab === 'analytics');
    document.body.classList.toggle('images-mode', APP.results === 'images');
}

function highlight(text, tokens)
{
    let html = esc(text);
    for (const t of tokens)
        html = html.replace(new RegExp(`(?<![\\p{L}\\p{N}])(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\p{L}\\p{N}])`, 'giu'), '<mark>$1</mark>');
    return html;
}

const KEYWORDS = /^(SELECT|FROM|WHERE|AND|OR|NOT|IN|AS|BY|GROUP|ORDER|LIMIT|DESC|ASC|WITH|JOIN|LEFT|INNER|ON|USING|UNION|ALL|DISTINCT|CASE|WHEN|THEN|ELSE|END|IS|NULL|BETWEEN|HAVING|SETTINGS|FORMAT|ARRAY|INTERVAL)$/i;
function highlightSql(sql)
{
    return String(sql ?? '').replace(/('(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)(\s*\()?|[^'A-Za-z0-9_]+/g, (m, str, n, word, call) =>
        str ? `<span class="str">${esc(str)}</span>`
        : n ? `<span class="num">${n}</span>`
        : word && call ? `<span class="fn">${esc(word)}</span>${esc(call)}`
        : word && KEYWORDS.test(word) ? `<span class="kw">${word}</span>`
        : esc(m));
}

function stats(result)
{
    const s = result?.statistics;
    return s ? `<b>${(s.elapsed * 1000).toFixed(0)} ms</b> · ${compact(s.rows_read)} rows · ${bytes(s.bytes_read)} read` : '';
}

function renderQueries(list)
{
    queries = list;
    queryIndex = Math.max(0, Math.min(queryIndex, list.length - 1));
    $('qtabs').innerHTML = list.map((q, i) => `<button type="button" data-i="${i}" class="${i === queryIndex ? 'on' : ''}">${esc(q.title ?? `Query ${i + 1}`)}</button>`).join('');
    $('qtabs').onclick = (event) =>
    {
        if (event.target.dataset.i === undefined)
            return;
        queryIndex = Number(event.target.dataset.i);
        renderQueries(queries);
    };
    $('qstat').innerHTML = stats(list[queryIndex]);
    $('sql').innerHTML = highlightSql(list[queryIndex]?.sql);
}

// rows: [{ bucket, series, value }] -> stacked columns.
function stackChart(rows)
{
    if (!rows?.length)
        return '<p class="note">No data.</p>';
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
            bars += `<rect x="${(i * w).toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(w - 1, 0.5).toFixed(2)}" height="${h.toFixed(2)}" fill="${color.get(r.series)}"><title>${esc(b)} · ${esc(r.series)}: ${num(r.value)}</title></rect>`;
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
        return '<p class="note">No data.</p>';
    const max = Math.max(...rows.map((r) => Number(r.value)), 1);
    return rows.map((r) => `<div class="hbar"><span title="${esc(r.label)}">${esc(r.label)}</span><div class="track"><i style="width:${Number(r.value) / max * 100}%"></i></div><span class="n">${num(r.value)}</span></div>`).join('');
}

const kpis = (row) => row
    ? `<div class="kpis">${Object.entries(row).map(([k, v]) => `<div class="kpi"><div class="v">${num(v)}</div><div class="k">${esc(k.replaceAll('_', ' '))}</div></div>`).join('')}</div>`
    : '<p class="note">No data.</p>';

function panelBody(p)
{
    return p.error ? `<p class="error">${esc(p.error)}</p>`
        : p.kind === 'stack' ? stackChart(p.result.data)
        : p.kind === 'bars' ? barChart(p.result.data)
        : kpis(p.result.data[0]);
}

function renderPanel(p, i)
{
    const sql = p.result
        ? `<div class="code under panel-sql" id="psql-${i}"><div class="bar"><i></i><i></i><i></i><span class="qstat">${stats(p.result)}</span></div><pre>${highlightSql(p.result.sql)}</pre></div>`
        : '';
    return `<div class="card${p.wide ? ' wide' : ''}"><h3>${esc(p.title)}${p.result ? `<button type="button" class="sqlbtn" data-p="${i}">SQL</button>` : ''}</h3>${panelBody(p)}${sql}</div>`;
}

async function fetchJson(path)
{
    const response = await fetch(path);
    const body = await response.json();
    if (!response.ok)
        throw new Error(body.error ?? `HTTP ${response.status}`);
    return body;
}

const seconds = (started) => `${((performance.now() - started) / 1000).toFixed(2)} s`;

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
    $('meta').innerHTML = '<span>Searching…</span>';
    $('hits').innerHTML = '';
    $('aside').innerHTML = '';
    renderQueries([]);
    const started = performance.now();
    try
    {
        if (tab === 'analytics')
        {
            const r = await fetchJson(`${api}/analytics?${search}`);
            if (current !== generation)
                return;
            $('meta').innerHTML = `<span>Analytics in <b>${seconds(started)}</b></span><span><b>${r.panels.filter((p) => !p.error).length}</b> of ${r.panels.length} queries ok</span>`;
            $('hits').innerHTML = `<div class="analytics">${r.panels.map(renderPanel).join('')}</div>`;
            $('hits').onclick = (event) => event.target.dataset.p !== undefined && $(`psql-${event.target.dataset.p}`).classList.toggle('open');
            return;
        }
        const route = APP.results === 'images' ? 'images' : 'search';
        const r = await fetchJson(`${api}/${route}?${search}`);
        if (current !== generation)
            return;
        if (r.blocked)
        {
            $('meta').innerHTML = `<span class="error">This query is blocked by the content-safety filter.</span>`;
            renderQueries([]);
            $('hits').innerHTML = '<div class="empty">Try a different image description.</div>';
            return;
        }
        const hits = r.hits ?? [];
        $('meta').innerHTML = `<span><b>${num(r.total)}</b> matches</span><span>showing <b>${hits.length}</b></span><span><b>${seconds(started)}</b></span>`;
        renderQueries([...(r.queries ?? []), ...(r.timeline?.result ? [{ ...r.timeline.result, title: r.timeline.title }] : [])]);
        if (APP.results === 'images')
        {
            $('hits').innerHTML = `<div class="image-grid">${hits.map((h) => `<article class="image-tile">
<img src="${esc(h.url)}" loading="lazy" referrerpolicy="no-referrer" alt="${esc(h.caption)}">
<div class="image-caption" title="${esc(h.caption)}">${esc(h.caption)}</div>
<div class="image-info"><span>CLIP ${Number(h.score).toFixed(3)}</span><button type="button" class="similar" data-similar="${esc(h.id)}">Similar</button></div>
</article>`).join('') || '<div class="empty">No images found.</div>'}</div>`;
            for (const image of $('hits').querySelectorAll('.image-tile img'))
                image.addEventListener('error', () => image.closest('.image-tile')?.remove(), { once: true });
            $('hits').onclick = (event) =>
            {
                const button = event.target.closest('button[data-similar]');
                if (!button)
                    return;
                const similar = $('f').elements.namedItem('similar');
                similar.value = button.dataset.similar;
                $('f').elements.namedItem('mode').value = 'semantic';
                run(true);
            };
            $('aside').innerHTML = '';
            return;
        }
        $('hits').innerHTML = hits.map((h) => `<div class="hit">
${h.url ? `<a class="title" href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a>` : `<span class="title">${esc(h.title)}</span>`}
<div class="text">…${highlight(h.snippet, r.tokens)}…</div>
<div class="info">${h.meta.map((m) => `<span>${esc(m)}</span>`).join('')}${(h.tags ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}${h.url ? `<a href="${esc(h.url)}" target="_blank" rel="noopener">Open ↗</a>` : ''}</div>
</div>`).join('') || '<div class="empty">No matches.</div>';
        const t = r.timeline;
        $('aside').innerHTML = t ? `<div class="card"><h3>${esc(t.title)}</h3>${panelBody(t)}</div>` : '';
    }
    catch (error)
    {
        if (current === generation)
            $('meta').innerHTML = `<span class="error">${esc(error.message)}</span>`;
    }
}

renderShell();
renderForm();
readState(new URLSearchParams(location.search));
window.onpopstate = () => { readState(new URLSearchParams(location.search)); run(); };
fetchJson('/api/datasets').then((list) =>
{
    if (!Array.isArray(list))
        return;
    datasets = list;
    renderNav();
}).catch(() => {});
fetchJson(`${api}/stats`).then((s) =>
{
    const fmt = { bytes, compact, num };
    $('stats').innerHTML = (APP.stats ?? []).map(([key, label, kind = 'compact']) =>
        `<div class="stat"><div class="v">${s[key] == null ? '–' : fmt[kind](s[key])}</div><div class="k">${esc(label)}</div></div>`).join('');
}).catch(() => {});
run();
