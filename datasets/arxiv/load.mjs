import { importFiles } from '../../lib/text_import.mjs';
import { options } from '../../lib/loader.mjs';

const opts = options({ table: 'arxiv_papers', files: 11 });
const HF = 'https://huggingface.co';
const count = Number(opts.files);
if (!Number.isInteger(count) || count < 1 || count > 11)
    throw new Error('--files must be between 1 and 11');

const files = Array.from({ length: count }, (_, index) =>
{
    const name = `data/train-${String(index).padStart(5, '0')}-of-00011.parquet`;
    return {
        unit: name,
        resolve: async () =>
        {
            const response = await fetch(`${HF}/datasets/librarian-bots/arxiv-metadata-snapshot/resolve/main/${name}`, { redirect: 'manual' });
            const location = response.headers.get('location');
            if (!location)
                throw new Error(`${name}: expected a Hugging Face redirect, got HTTP ${response.status}`);
            return new URL(location, HF).href;
        },
    };
});

await importFiles({
    table: opts.table,
    files,
    indexes: [
        { name: 'idx_title', expression: 'lowerUTF8(__raw_data.title::String)' },
        { name: 'idx_abstract', expression: 'lowerUTF8(__raw_data.abstract::String)' },
    ],
});
