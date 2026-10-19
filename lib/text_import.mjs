import { describeTable, execute, insertFromUrl, literal, query } from './rawtree.mjs';
import { doneSet, log, retry } from './loader.mjs';

const INDEX_MARKER = '__text_indexes_materialized__';

export async function ensureIndexes(table, indexes, done)
{
    const { table: info } = await describeTable(table);
    if (!info)
        throw new Error(`Unable to describe ${table}`);
    log('table', table, `rows=${info.total_rows}`, `sorting_key=${info.sorting_key}`);

    const result = await query(`SELECT name FROM system.data_skipping_indices WHERE database = ${literal(process.env.RAWTREE_DATABASE ?? 'default')} AND table = ${literal(table)}`);
    const existing = new Set(result.data.map((index) => index.name));
    for (const index of indexes)
    {
        if (!existing.has(index.name))
        {
            log('create index', table, index.name);
            await execute(`ALTER TABLE ${table} ADD INDEX ${index.name} ${index.expression} TYPE text(tokenizer = splitByNonAlpha)`);
        }
    }

    if (!done.has(INDEX_MARKER))
    {
        for (const index of indexes)
        {
            log('materialize index', table, index.name);
            await execute(`ALTER TABLE ${table} MATERIALIZE INDEX ${index.name}`);
        }
        done.add(INDEX_MARKER);
    }
}

export async function importFiles({ table, files, indexes })
{
    const done = doneSet(table);
    const first = files[0];

    if (first && done.has(first.unit) && !done.has(INDEX_MARKER))
        await ensureIndexes(table, indexes, done);

    for (const file of files)
    {
        if (done.has(file.unit))
            continue;
        log('start', table, file.unit);
        const result = await retry(async () =>
        {
            const source = file.resolve ? await file.resolve() : file.url;
            return insertFromUrl(table, source, { dedupToken: `${table}-${file.unit}` });
        }, file.unit);
        log('imported', table, file.unit, JSON.stringify(result));
        done.add(file.unit);
        if (file === first)
            await ensureIndexes(table, indexes, done);
    }

    log('done', table, `completed=${files.filter((file) => done.has(file.unit)).length}`, `selected=${files.length}`);
}
