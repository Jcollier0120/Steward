/**
 * The small part of JSON Schema the kit's reports use (spec/npu-bench.schema.json, spec/npu-report.schema.json): type
 * (with "integer", and several types at once), enum, const, required, properties, additionalProperties, items, pattern
 * (Unicode), maxLength, minimum, maximum, and $ref to the schema's own "#/$defs/<name>". Problems in words, none when
 * the value matches.
 */
export function checkSchema(value: unknown, schema: any, at = 'report', root: any = schema): string[] {
  if (typeof schema?.$ref === 'string') {
    const name = /^#\/\$defs\/(.+)$/.exec(schema.$ref)?.[1];
    const def = name ? root?.$defs?.[name] : undefined;
    return def ? checkSchema(value, def, at, root) : [`${at}'s schema names ${schema.$ref}, which it hasn't`];
  }
  const problems: string[] = [];
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null;
  const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  if (types) {
    const t = typeOf(value);
    if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) return [`${at} is ${t}, not ${types.join(' or ')}`];
  }
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${at} is ${JSON.stringify(value)}, not one of ${schema.enum.join(', ')}`);
  if (schema.const !== undefined && value !== schema.const) problems.push(`${at} isn't ${JSON.stringify(schema.const)}`);
  if (typeof value === 'string') {
    if (typeof schema.maxLength === 'number' && [...value].length > schema.maxLength) problems.push(`${at} is longer than ${schema.maxLength}`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) problems.push(`${at} doesn't match its pattern`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) problems.push(`${at} is under ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) problems.push(`${at} is over ${schema.maximum}`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    // Own keys only, on both sides: "constructor" or "__proto__" in a report is a key like any other, never Object's.
    for (const k of schema.required ?? []) if (!Object.hasOwn(value, k)) problems.push(`${at}.${k} is missing`);
    for (const [k, v] of Object.entries(value as object)) {
      const own = schema.properties && Object.hasOwn(schema.properties, k) ? schema.properties[k] : undefined;
      const sub = own ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined);
      if (sub) problems.push(...checkSchema(v, sub, `${at}.${k}`, root));
      else if (schema.additionalProperties === false) problems.push(`${at}.${k} isn't in the schema`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => problems.push(...checkSchema(v, schema.items, `${at}[${i}]`, root)));
  return problems;
}
