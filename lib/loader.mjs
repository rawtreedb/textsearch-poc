// Helpers shared by the dataset loaders: CLI options and a JSON file recording finished work units, so re-runs resume.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

export const DATA_DIR = process.env.DATA_DIR ?? './data';

export function options(spec)
{
    const { values } = parseArgs({ options: Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, { type: 'string', default: String(v) }])) });
    return values;
}

export function doneSet(name)
{
    const file = path.join(DATA_DIR, `${name}.done.json`);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const done = new Set(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
    return {
        has: (unit) => done.has(unit),
        add(unit)
        {
            done.add(unit);
            fs.writeFileSync(`${file}.tmp`, JSON.stringify([...done].sort(), null, 1));
            fs.renameSync(`${file}.tmp`, file);
        },
    };
}

export const log = (...args) => console.log(new Date().toISOString(), ...args);

export async function retry(fn, label, attempts = 4)
{
    for (let attempt = 1; ; attempt++)
    {
        try { return await fn(); }
        catch (error)
        {
            if (error.name === 'AbortError' || attempt >= attempts)
                throw error;
            log(`${label}: ${error.message}; retry ${attempt}`);
            await new Promise((resolve) => setTimeout(resolve, 15_000 * attempt));
        }
    }
}
