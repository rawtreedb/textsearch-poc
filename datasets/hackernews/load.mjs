import { importFiles } from '../../lib/text_import.mjs';
import { options } from '../../lib/loader.mjs';

const opts = options({ table: 'hackernews_items' });
const source = 'https://datasets-documentation.s3.eu-west-3.amazonaws.com/hackernews/2023-08-18.parquet';

await importFiles({
    table: opts.table,
    files: [{ unit: '2023-08-18.parquet', url: source }],
    indexes: [
        { name: 'idx_title', expression: 'lowerUTF8(__raw_data.title::String)' },
        { name: 'idx_text', expression: 'lowerUTF8(__raw_data.text::String)' },
    ],
});
