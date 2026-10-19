import { importFiles } from '../../lib/text_import.mjs';
import { options } from '../../lib/loader.mjs';

const files = [
    'train-00000-of-00037-f5fce855b93d2d02.parquet','train-00001-of-00037-9f227d74fc154ce9.parquet','train-00002-of-00037-bea1b37be317e1da.parquet','train-00003-of-00037-04e66b9f8137658b.parquet','train-00004-of-00037-f6c07110175b63c4.parquet','train-00005-of-00037-ba4d58fedca00030.parquet','train-00006-of-00037-7b789f01c0c22b60.parquet','train-00007-of-00037-6bbe2fa08aa33167.parquet','train-00008-of-00037-033888fa3848dd16.parquet','train-00009-of-00037-8b793451f276e572.parquet','train-00010-of-00037-316f04ddc46599fe.parquet','train-00011-of-00037-099dbd5b328cdaf9.parquet','train-00012-of-00037-4f4740996a047290.parquet','train-00013-of-00037-db4f861f78cdda53.parquet','train-00014-of-00037-be958e077450074e.parquet','train-00015-of-00037-3e422fddf4a02b68.parquet','train-00016-of-00037-45b3a0df26130cfb.parquet','train-00017-of-00037-116da6a2fc3d46d8.parquet','train-00018-of-00037-3669e1517089c76d.parquet','train-00019-of-00037-8b2f1a8fec0a2108.parquet','train-00020-of-00037-3d99168fa7b0edf8.parquet','train-00021-of-00037-8ab80417e78ceb52.parquet','train-00022-of-00037-0944fc61fb4ac30c.parquet','train-00023-of-00037-d7895637ed3af5d6.parquet','train-00024-of-00037-09bea13a1df15924.parquet','train-00025-of-00037-473104aa5efb2fd7.parquet','train-00026-of-00037-4b7511a415a20078.parquet','train-00027-of-00037-66093127ec6001b6.parquet','train-00028-of-00037-fe9e77c7977cfb8c.parquet','train-00029-of-00037-43de64be3239f167.parquet','train-00030-of-00037-ff9b258680737e11.parquet','train-00031-of-00037-73093f2c2aca90ab.parquet','train-00032-of-00037-1fafc6475b8daf9b.parquet','train-00033-of-00037-9427a3c9a9209280.parquet','train-00034-of-00037-a50c4691ce79764c.parquet','train-00035-of-00037-fbd49649c7559302.parquet','train-00036-of-00037-f95604828486ccd8.parquet',
];
const opts = options({ table: 'gutenberg_books', files: 37 });
const count = Number(opts.files);
if (!Number.isInteger(count) || count < 1 || count > files.length) throw new Error('--files must be between 1 and 37');
await importFiles({
    table: opts.table,
    files: files.slice(0, count).map((name) => ({
        unit: name,
        resolve: async () => {
            const response = await fetch(`https://huggingface.co/datasets/sedthh/gutenberg_english/resolve/main/data/${name}`, { redirect: 'manual' });
            const location = response.headers.get('location');
            if (!location) throw new Error(`${name}: expected a Hugging Face redirect, got HTTP ${response.status}`);
            return new URL(location, 'https://huggingface.co').href;
        },
    })),
    indexes: [{ name: 'idx_text', expression: 'lowerUTF8(__raw_data.TEXT::String)' }],
});
