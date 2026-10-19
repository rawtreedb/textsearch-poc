// Query building shared by the dataset APIs. The text indexes are `lowerUTF8(<column>) TYPE text(tokenizer = standard)`,
// so conditions use the same expression and tokens follow the same rule.
import { literal } from './rawtree.mjs';

export class HttpError extends Error
{
    constructor(status, message)
    {
        super(message);
        this.status = status;
    }
}

// The `standard` tokenizer splits on Unicode word boundaries (UAX #29), like `Intl.Segmenter`, so `it's` and `3.14` stay one token.
const words = new Intl.Segmenter('en', { granularity: 'word' });

export function tokenize(q)
{
    return [...words.segment(String(q ?? '').toLowerCase())]
        .filter((s) => s.isWordLike && /[\p{L}\p{N}]/u.test(s.segment))
        .map((s) => s.segment)
        .slice(0, 10);
}

export const MODES = ['all', 'any', 'phrase'];

// Condition on one indexed expression, e.g. textCondition('lowerUTF8(text::String)', ['rust'], 'all').
export function textCondition(expr, tokens, mode)
{
    const arr = `[${tokens.map(literal).join(', ')}]`;
    if (mode === 'phrase')
        return `hasPhrase(${expr}, ${literal(tokens.join(' '))})`;
    if (mode === 'any')
        return `hasAnyTokens(${expr}, ${arr})`;
    return `hasAllTokens(${expr}, ${arr})`;
}

export function parseSearch(params)
{
    const tokens = tokenize(params.get('q'));
    const mode = MODES.includes(params.get('mode')) ? params.get('mode') : 'all';
    if (!tokens.length)
        throw new HttpError(400, 'Enter at least one word');
    return { tokens, mode };
}

// ~300 characters of `expr` around the first occurrence of the first token (start of the text if absent).
export function snippet(expr, tokens, width = 300)
{
    const position = tokens.length ? `positionCaseInsensitiveUTF8(${expr}, ${literal(tokens[0])})` : '0';
    return `substringUTF8(${expr}, greatest(1, toInt64(${position}) - ${Math.round(width / 3)}), ${width})`;
}

export const intParam = (params, name, fallback, min, max) =>
{
    const value = Number.parseInt(params.get(name) ?? '', 10);
    return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
};

// Runs analytics panels independently so one failing query does not hide the others.
export const panel = (meta, promise) => promise.then((result) => ({ ...meta, result })).catch((error) => ({ ...meta, error: error.message }));
