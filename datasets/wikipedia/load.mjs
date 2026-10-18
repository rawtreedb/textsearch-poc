// Imports Wikipedia articles (Hugging Face `wikimedia/wikipedia`, Parquet: id, url, title, text) into a raw table,
// one server-side URL import per file. Hugging Face redirects to a signed CDN URL, which is resolved here because the import does not follow redirects.
// Usage: node datasets/wikipedia/load.mjs [--snapshot 20231101] [--langs en] [--table wikipedia_articles] [--files 0]  (--files N > 0 limits files per language)
import { insertFromUrl } from '../../lib/rawtree.mjs';
import { doneSet, log, options, retry } from '../../lib/loader.mjs';

const opts = options({ snapshot: '20231101', langs: 'en', table: 'wikipedia_articles', files: 0 });
const done = doneSet(opts.table);
const HF = 'https://huggingface.co';

async function parquetFiles(config)
{
    const response = await fetch(`${HF}/api/datasets/wikimedia/wikipedia/tree/main/${config}`);
    if (!response.ok)
        throw new Error(`Hugging Face listing ${config}: HTTP ${response.status}`);
    return (await response.json()).map((entry) => entry.path).filter((p) => p.endsWith('.parquet')).sort();
}

async function resolveRedirect(file)
{
    const response = await fetch(`${HF}/datasets/wikimedia/wikipedia/resolve/main/${file}`, { redirect: 'manual' });
    const location = response.headers.get('location');
    if (!location)
        throw new Error(`${file}: expected a redirect, got HTTP ${response.status}`);
    return new URL(location, HF).href;
}

for (const lang of opts.langs.split(','))
{
    let files = await parquetFiles(`${opts.snapshot}.${lang}`);
    if (Number(opts.files) > 0)
        files = files.slice(0, Number(opts.files));
    for (const file of files)
    {
        if (done.has(file))
            continue;
        const result = await retry(async () => insertFromUrl(opts.table, await resolveRedirect(file), { dedupToken: `wikipedia-${file}` }), file);
        log(file, JSON.stringify(result));
        done.add(file);
    }
}
log('done');
