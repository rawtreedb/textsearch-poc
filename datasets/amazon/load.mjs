import { importFiles } from '../../lib/text_import.mjs';
import { options } from '../../lib/loader.mjs';

const opts = options({ table: 'amazon_reviews', from: 0, to: 7, files: '' });
const bucket = 'https://datasets-documentation.s3.eu-west-3.amazonaws.com/amazon_reviews';
const sources = [
    'amazon_reviews_1990s.snappy.parquet',
    'amazon_reviews_2000s.snappy.parquet',
    ...Array.from({ length: 6 }, (_, index) => `amazon_reviews_${2010 + index}.snappy.parquet`),
].map((name) => ({ unit: name, url: `${bucket}/${name}` }));

let files;
if (opts.files)
{
    files = opts.files.split(',').map((value) =>
    {
        const index = /^\d+$/.test(value) ? Number(value) : -1;
        return sources[index] ?? sources.find((source) => source.unit === value);
    });
    if (files.some((file) => !file))
        throw new Error('--files must contain source file names or zero-based file indexes');
}
else
{
    const from = Number(opts.from);
    const to = Number(opts.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to >= sources.length)
        throw new Error(`Expected --from/--to indexes between 0 and ${sources.length - 1}`);
    files = sources.slice(from, to + 1);
}

await importFiles({
    table: opts.table,
    files,
    indexes: [
        { name: 'idx_review_headline', expression: 'lowerUTF8(__raw_data.review_headline::String)' },
        { name: 'idx_review_body', expression: 'lowerUTF8(__raw_data.review_body::String)' },
    ],
});
