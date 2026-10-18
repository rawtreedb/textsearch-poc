import { literal, query } from '../../lib/rawtree.mjs';
import { intParam, panel, parseSearch, snippet, textCondition } from '../../lib/search.mjs';

const TABLE = 'loghub_lines';
const LABEL = '__raw_data.label::String';
export const SYSTEMS = ['HDFS_v1','HDFS_v2','HDFS_v3_TraceBench','Hadoop','Spark','Zookeeper','OpenStack','BGL','HPC','Thunderbird','Windows','Linux','Mac','Android_v1','Android_v2','HealthApp','Apache','SSH','Proxifier'];
const TS = 'parseDateTimeBestEffortOrNull(ts::String)';

function filter(params)
{
    const { tokens, mode } = parseSearch(params);
    const where = [textCondition('lowerUTF8(message::String)', tokens, mode)];
    const systems = params.getAll('system').filter(Boolean);
    if (systems.length) where.push(`system::String IN (${systems.filter((x) => SYSTEMS.includes(x)).map(literal).join(', ') || "''"})`);
    const level = (params.get('level') ?? '').trim();
    if (level) where.push(`positionCaseInsensitiveUTF8(level::String, ${literal(level)}) > 0`);
    if (params.get('alerts') === 'yes') where.push(`system::String IN ('BGL','Thunderbird') AND ${LABEL} != '' AND ${LABEL} != '-'`);
    const from = intParam(params, 'from', 2000, 1970, 2030), to = intParam(params, 'to', 2030, 1970, 2030);
    if (from > 2000) where.push(`${TS} >= toDateTime('${from}-01-01 00:00:00')`);
    if (to < 2030) where.push(`${TS} < toDateTime('${to + 1}-01-01 00:00:00')`);
    return { tokens, where: where.join('\n AND ') };
}

async function search(params)
{
    const { tokens, where } = filter(params);
    const limit = intParam(params, 'limit', 30, 1, 100);
    const order = params.get('sort') === 'system' ? 'system, file, line_no' : 'ts::String DESC';
    const hitsSql = `SELECT system, file, line_no, ts, level, component, message, ${LABEL} AS label, ${snippet('message::String', tokens)} AS snippet FROM ${TABLE} WHERE ${where} ORDER BY ${order} LIMIT ${limit}`;
    const countSql = `SELECT count() AS matches FROM ${TABLE} WHERE ${where}`;
    const timeSql = `SELECT toStartOfMonth(${TS}) AS bucket, system AS series, count() AS value FROM ${TABLE} WHERE ${where} AND ${TS} IS NOT NULL GROUP BY bucket, series ORDER BY bucket`;
    const [hits, count, timeline] = await Promise.all([query(hitsSql), query(countSql), query(timeSql)]);
    return {
        tokens, total: Number(count.data[0]?.matches ?? 0),
        hits: hits.data.map((r) => ({ title: `${r.system}${r.component ? ` · ${r.component}` : ''}${r.level ? ` · ${r.level}` : ''}${r.ts ? ` · ${r.ts}` : ''}`, url: '', snippet: r.snippet, meta: [r.file, `line ${r.line_no}`, r.label && r.label !== '-' ? `alert: ${r.label}` : ''].filter(Boolean) })),
        timeline: { title: 'Matches by month and system', kind: 'stack', result: timeline },
        queries: [{ title: 'Matching log lines', ...hits }, { title: 'Matching log lines', ...count }, { title: 'Timeline', ...timeline }],
    };
}

async function analytics(params)
{
    const { where } = filter(params);
    const sqls = [
        `SELECT system AS label, count() AS value FROM ${TABLE} WHERE ${where} GROUP BY label ORDER BY value DESC`,
        `SELECT ifNull(level::String, 'unknown') AS label, count() AS value FROM ${TABLE} WHERE ${where} GROUP BY label ORDER BY value DESC LIMIT 12`,
        `SELECT ifNull(component::String, 'unknown') AS label, count() AS value FROM ${TABLE} WHERE ${where} GROUP BY label ORDER BY value DESC LIMIT 12`,
        `SELECT ifNull(nullIf(${LABEL}, ''), 'unknown') AS label, count() AS value FROM ${TABLE} WHERE ${where} AND system::String IN ('BGL','Thunderbird') AND ${LABEL} != '' AND ${LABEL} != '-' GROUP BY label ORDER BY value DESC LIMIT 12`,
        `SELECT message AS label, count() AS value FROM ${TABLE} WHERE ${where} GROUP BY label ORDER BY value DESC LIMIT 12`,
    ];
    const titles = ['Lines per system', 'Level distribution', 'Top components', 'Alert categories', 'Top messages'];
    return { panels: await Promise.all(sqls.map((sql, i) => panel({ title: titles[i], kind: 'bars' }, query(sql)))) };
}

async function stats()
{
    const result = await query(`SELECT count() AS lines FROM ${TABLE}`);
    return result.data[0];
}

export default { id: 'loghub', title: 'Loghub', description: 'Search a collection of system logs.', routes: { search, analytics, stats } };
