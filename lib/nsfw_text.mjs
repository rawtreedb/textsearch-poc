// Hashtags and tokens that mark a post as adult content. Picked from hashtags on posts that Bluesky's
// moderation service labeled porn/sexual/nudity; matching is on whole hashtags or tokens only.
export const NSFW_TAGS = new Set([
    'nsfw', 'nsfwart', 'nsfwartist', 'nsfwalt', 'nsfwtwt', 'porn', 'nude', 'nudes', 'naked', 'xxx', 'lewd', 'hentai',
    'r18', 'onlyfans', 'fansly', 'pussy', 'tits', 'boobs', 'cock', 'dick', 'gooning', 'gooner', 'goonfuel',
    'sundaycumday', 'erotic', 'eroticart', 'zoophilia', 'fanza', 'dlsite', '섹블', '섹트', '야짤',
]);
const NSFW_TOKENS = /(?<![\p{L}\p{N}_])(?:nsfw|onlyfans|fansly|porn|hentai|r18|18\+|섹블|섹트)(?![\p{L}\p{N}_])/iu;
const HASHTAG = /#([^\s#]+)/gu;

export function isNsfwText(text, tags = [], alts = [])
{
    const strings = [text, ...alts].filter((value) => typeof value === 'string');
    if (strings.some((value) => NSFW_TOKENS.test(value)))
        return true;
    const hashtags = strings.flatMap((value) => [...value.matchAll(HASHTAG)].map((match) => match[1]));
    return [...(Array.isArray(tags) ? tags : []), ...hashtags]
        .some((tag) => typeof tag === 'string' && NSFW_TAGS.has(tag.toLowerCase().replace(/[.,!?:;]+$/u, '')));
}
