import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const examples = {
  path: 'path/to/file.txt',
  offset: 0,
  limit: 100,
};

function exampleFor(name, schema) {
  if ('example' in schema) return schema.example;
  if ('default' in schema) return schema.default;
  if (name in examples) return examples[name];
  if (schema.enum?.length) return schema.enum[0];

  const type = schema.type ?? schema.anyOf?.[0]?.type;
  if (type === 'string') return 'value';
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean') return false;
  if (type === 'array') return [];
  if (type === 'object') return {};
  return 'value';
}

function display(value) {
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function convertTool(tool) {
  const definition = tool?.function;
  if (typeof definition?.name !== 'string' || !definition.name) {
    throw new TypeError('Each tool must have function.name');
  }

  const parameters = definition.parameters ?? {};
  const required = new Set(parameters.required ?? []);
  const lines = [
    `### ${definition.name}`,
    definition.description ?? '',
    '[(S)USERREQUEST]',
    `tool:${definition.name}`,
  ];

  for (const [name, schema] of Object.entries(parameters.properties ?? {})) {
    const details = [
      !required.has(name) && 'optional',
      schema.type ?? 'value',
      schema.description,
    ].filter(Boolean);
    lines.push(`${name}:${display(exampleFor(name, schema))} (${details.join(', ')})`);
  }

  lines.push('[(E)USERREQUEST]');
  return lines.join('\n');
}

export class JsonToToolFormat {
  convert(input) {
    const data = typeof input === 'string' ? JSON.parse(input) : input;
    const tools = Array.isArray(data?.tools) ? data.tools : [data];
    return `${tools.map((tool) => convertTool(tool).replaceAll('\n\n', '\n')).join('\n\n')}\n`;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const inputPath = process.argv[2] ?? fileURLToPath(new URL('../reference/tools.json', import.meta.url));
  console.log(new JsonToToolFormat().convert(fs.readFileSync(inputPath, 'utf8')).trimEnd());
}
