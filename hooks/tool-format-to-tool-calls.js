import { randomUUID } from 'node:crypto';

const blockPattern = /\[\(S\)USERREQUEST\]\r?\n([^]*?)\r?\n\[\(E\)USERREQUEST\]/g;

function valueFor(value, schema) {
    if (schema?.type === 'string' || !schema?.type) return value;
    try {
        return JSON.parse(value);
    } catch {
        throw new TypeError(`Invalid ${schema.type} value: ${value}`);
    }
}

function canonicalArguments(lines, tool) {
    const properties = tool.function.parameters?.properties ?? {};
    const names = Object.keys(properties);
    const values = {};
    let current;
    let currentIndex = -1;

    for (const line of lines) {
        const separator = line.indexOf(':');
        const name = separator < 1 ? '' : line.slice(0, separator);
        const index = names.indexOf(name);
        if (index > currentIndex) {
            current = name;
            currentIndex = index;
            values[name] = line.slice(separator + 1);
        } else if (current && properties[current]?.type === 'string') {
            values[current] += `\n${line}`;
        } else {
            throw new TypeError(`Invalid tool argument: ${line}`);
        }
    }

    return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, valueFor(value, properties[name])]));
}

function shorthandRequest(lines) {
    const separator = lines[0].indexOf(':');
    if (separator < 1) throw new TypeError(`Invalid tool request: ${lines[0]}`);
    const command = lines[0].slice(0, separator);
    const value = lines[0].slice(separator + 1);

    if (command === 'read') return ['read', { path: value }];
    if (command === 'execute') return ['bash', { command: value }];
    if (command === 'write') return ['write', { path: value, content: lines.slice(1).join('\n') }];
    if (command === 'edit') {
        const original = lines.indexOf('[ORIGINALCODE]');
        const replacement = lines.indexOf('[REPLACECODE]');
        if (original < 0 || replacement <= original) throw new TypeError('Invalid edit request');
        return ['edit', {
            path: value,
            edits: [{
                oldText: lines.slice(original + 1, replacement).join('\n'),
                newText: lines.slice(replacement + 1).join('\n'),
            }],
        }];
    }
    return [command, {}];
}

export function toolFormatToToolCalls(content, tools){
    const blocks = [...content.matchAll(blockPattern)];
    if (!blocks.length || content.replace(blockPattern, '').trim()) {
        throw new TypeError('Response must contain only USERREQUEST blocks');
    }

    return blocks.map(([, body]) => {
        const lines = body.replace(/\r/g, '').split('\n');
        let name;
        let args;
        if (lines[0].startsWith('tool:')) {
            name = lines.shift().slice('tool:'.length);
            const tool = tools?.find((item) => item.function?.name === name);
            if (!tool) throw new TypeError(`Unknown tool: ${name}`);
            args = canonicalArguments(lines, tool);
        } else {
            [name, args] = shorthandRequest(lines);
            if (!tools?.some((item) => item.function?.name === name)) throw new TypeError(`Unknown tool: ${name}`);
        }
        
        return {
            id: `call_${randomUUID().replaceAll('-', '')}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
        };
    });
}
