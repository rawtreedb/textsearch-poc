import { embedTexts } from './text_embed.mjs';

process.on('disconnect', () => process.exit(0));

process.on('message', async ({ id, texts }) =>
{
    try
    {
        const vectors = await embedTexts(texts);
        process.send({ id, vectors });
    }
    catch (error)
    {
        process.send({ id, error: error.message, stack: error.stack });
    }
});

process.send({ ready: true });
