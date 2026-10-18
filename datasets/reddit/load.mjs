import { importFiles } from '../../lib/text_import.mjs';
import { options } from '../../lib/loader.mjs';

const opts = options({ table: 'reddit_comments', from: '2012-01', to: '2016-02' });
const HF = 'https://huggingface.co';

function monthIndex(value)
{
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
    if (!match)
        throw new Error(`Invalid month: ${value}`);
    return Number(match[1]) * 12 + Number(match[2]) - 1;
}

const first = monthIndex(opts.from);
const last = monthIndex(opts.to);
if (last < first || opts.from < '2012-01' || opts.to > '2016-02')
    throw new Error('--from/--to must be an inclusive range from 2012-01 through 2016-02');

const files = Array.from({ length: last - first + 1 }, (_, offset) =>
{
    const value = first + offset;
    const month = `${Math.floor(value / 12)}-${String(value % 12 + 1).padStart(2, '0')}`;
    const name = `data/RC_${month}.parquet`;
    return {
        unit: month,
        resolve: async () =>
        {
            const response = await fetch(`${HF}/datasets/fddemarco/pushshift-reddit-comments/resolve/main/${name}`, { redirect: 'manual' });
            const location = response.headers.get('location');
            if (!location)
                throw new Error(`${month}: expected a Hugging Face redirect, got HTTP ${response.status}`);
            return new URL(location, HF).href;
        },
    };
});

await importFiles({
    table: opts.table,
    files,
    indexes: [{ name: 'idx_body', expression: 'lowerUTF8(__raw_data.body::String)' }],
});
