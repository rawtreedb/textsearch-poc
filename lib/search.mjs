// Query building shared by the dataset APIs. The text indexes are `lowerUTF8(<column>) TYPE text(tokenizer = splitByNonAlpha)`,
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

// `splitByNonAlpha` keeps ASCII alphanumerics and any non-ASCII run. Tokens only contain these characters, so they are SQL-literal safe.
export function tokenize(q)
{
    return (String(q ?? '').toLowerCase().match(/[a-z0-9\u0080-\uffff]+/g) ?? []).slice(0, 10);
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
