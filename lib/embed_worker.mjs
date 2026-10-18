import { embedTexts } from './text_embed.mjs';

const threads = Number(process.argv[2]);

process.on('disconnect', () => process.exit(0));

process.on('message', async ({ texts }) =>
{
    try
    {
        process.send({ vectors: await embedTexts(texts, { threads }) });
    }
    catch (error)
    {
        process.send({ error: error.message });
    }
});
