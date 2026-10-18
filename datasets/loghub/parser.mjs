const iso = (date, time = '00:00:00') =>
{
    const value = new Date(`${date.replaceAll('.', '-')}T${time.replace(',', '.')}${time.includes('.') ? '' : '.000'}Z`);
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
};
const epoch = (value) => Number.isFinite(Number(value)) ? new Date(Number(value) * 1000).toISOString() : null;
const yy = (value) => Number(value) > 69 ? `19${value}` : `20${value}`;

export function parseLog(system, line)
{
    let m;
    if (/^HDFS_/.test(system) && (m = line.match(/^(\d{6})\s+(\d{6})\s+\S+\s+(\S+)\s+([^:]+):\s?(.*)$/)))
        return { ts: iso(`${yy(m[1].slice(0, 2))}-${m[1].slice(2, 4)}-${m[1].slice(4, 6)}`, `${m[2].slice(0, 2)}:${m[2].slice(2, 4)}:${m[2].slice(4, 6)}`), level: m[3], component: m[4], message: m[5], label: null };
    if (system === 'Hadoop' && (m = line.match(/^(\d{4}-\d\d-\d\d)\s+(\d\d:\d\d:\d\d)[,.]\d+\s+(\w+)\s+\[([^\]]+)\]\s+([^:]+):\s*(.*)$/)))
        return { ts: iso(m[1], m[2]), level: m[3], component: m[5].trim(), message: m[6], label: null };
    if (system === 'Spark' && (m = line.match(/^(\d\d)\/(\d\d)\/(\d\d)\s+(\d\d:\d\d:\d\d)\s+(\w+)\s+([^:]+):\s*(.*)$/)))
        return { ts: iso(`${yy(m[1])}-${m[2]}-${m[3]}`, m[4]), level: m[5], component: m[6].trim(), message: m[7], label: null };
    if (system === 'Zookeeper' && (m = line.match(/^(\d{4}-\d\d-\d\d)\s+(\d\d:\d\d:\d\d)[,.]\d+\s+-\s+(\w+)\s+\[(.*?)\]\s+-\s+(.*)$/)))
        return { ts: iso(m[1], m[2]), level: m[3], component: m[4].split(':').at(-1).split('@')[0], message: m[5], label: null };
    if (system === 'BGL' && (m = line.match(/^(\S+)\s+(\d{10})\s+(\d{4}\.\d\d\.\d\d)\s+\S+\s+\S+\s+\S+\s+\S+\s+(\S+)\s+(\S+)\s+(.*)$/)))
        return { ts: epoch(m[2]), level: m[5], component: m[4], message: m[6], label: m[1] };
    if (system === 'HPC' && (m = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(.+?)\s+(\d{10})\s+\S+\s+(.*)$/)))
        return { ts: epoch(m[5]), level: m[4], component: m[3], message: m[6], label: null };
    if (system === 'Thunderbird' && (m = line.match(/^(\S+)\s+(\d{10})\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+([^\[(]+)(?:\[(\d+)\])?:\s*(.*)$/)))
        return { ts: epoch(m[2]), level: null, component: m[3].trim(), message: m[5], label: m[1] };
    if (system === 'Windows' && (m = line.match(/^(.+?)\s+(\d\d:\d\d:\d\d(?:\.\d+)?)\s*,\s*(\w+)\s{2,}(\S+)\s{2,}(.*)$/)))
        return { ts: /\b(?:19|20)\d{2}\b/.test(m[1]) ? iso(m[1].trim(), m[2]) : null, level: m[3], component: m[4], message: m[5], label: null };
    if (system === 'Linux' && (m = line.match(/^\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\S+\s+([^\s:]+)(?:\[\d+\])?(?:\s+([^:]+))?:\s*(.*)$/)))
        return { ts: null, level: null, component: m[1], message: [m[2], m[3]].filter(Boolean).join(': '), label: null };
    if (system === 'Mac' && (m = line.match(/^\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\S+\s+([^\[]+)\[\d+\](?:\s+\([^)]*\))?:\s*(.*)$/)))
        return { ts: null, level: null, component: m[1].trim(), message: m[2], label: null };
    if (/^Android_/.test(system) && (m = line.match(/^\d\d-\d\d\s+(\d\d:\d\d:\d\d\.\d+)\s+\d+\s+\d+\s+([VDIWEF])\s+([^:]+):\s*(.*)$/)))
        return { ts: null, level: m[2], component: m[3], message: m[4], label: null };
    if (system === 'HealthApp' && (m = line.match(/^(\d{6}|\d{8})-(\d{1,2}):(\d{1,2}):(\d{1,2}):(\d{1,3})\|([^|]+)\|[^|]+\|(.*)$/)))
    {
        const date = m[1].length === 8 ? `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}` : '';
        const time = `${m[2].padStart(2, '0')}:${m[3].padStart(2, '0')}:${m[4].padStart(2, '0')}.${m[5].padStart(3, '0')}`;
        return { ts: date ? iso(date, time) : null, level: null, component: m[6], message: m[7], label: null };
    }
    if (system === 'Apache' && (m = line.match(/^\[([^\]]+)\]\s+\[(\w+)\]\s+(.*)$/)))
        return { ts: Number.isNaN(Date.parse(`${m[1]} UTC`)) ? null : new Date(`${m[1]} UTC`).toISOString(), level: m[2], component: null, message: m[3], label: null };
    if (system === 'Proxifier' && (m = line.match(/^\[\d\d\.\d\d \d\d:\d\d:\d\d\]\s+(.+?)\s+-\s+(.*)$/)))
        return { ts: null, level: null, component: m[1], message: m[2], label: null };
    if (system === 'SSH' && (m = line.match(/^\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\S+\s+sshd(?:\[\d+\])?:\s*(.*)$/)))
        return { ts: null, level: null, component: 'sshd', message: m[1], label: null };
    if (system === 'OpenStack' && (m = line.match(/^\S+\s+(\d{4}-\d\d-\d\d)\s+(\d\d:\d\d:\d\d)\.\d+\s+\d+\s+(\w+)\s+(\S+)\s+\[(.*?)\]\s+(.*)$/)))
        return { ts: iso(m[1], m[2]), level: m[3], component: m[4], message: m[6], label: null };
    return null;
}
