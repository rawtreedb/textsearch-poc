export function vectorLiteral(vector)
{
    return `[${Array.from(vector, (value) => Number(value).toFixed(6)).join(', ')}]::Array(Float32)`;
}
