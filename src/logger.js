// JSONL file + console logger.
// File: every event is appended immediately (synchronously) as one-line JSON to
//   logs/YYYY-MM-DD.log (LOCAL date, so the filename matches "today").
// Console: a human-readable, colored one-liner per event (colors only on a TTY).
// Synchronous appends are intentional: this is a low-QPS local gateway, and it guarantees
// the file is visible/flushed right away and survives a crash or a hard kill.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const MAX_CONTENT = 1000;

// Per-request console output is opt-in (--verbose); the JSONL file is always written.
let verbose = false;

export function setVerbose(value) {
  verbose = Boolean(value);
}

export function isVerbose() {
  return verbose;
}

// ── console formatting ──────────────────────────────────────────────
const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function paint(code, text) {
  return COLOR ? `${code}${text}${C.reset}` : String(text);
}

// Default style for event types not listed below (e.g. custom plugin events).
const DEFAULT_TYPE_STYLE = C.reset;

const TYPE_STYLE = {
  gateway_start: C.blue,
  client_request: C.cyan,
  request_intercepted: C.magenta,
  upstream_request: C.blue,
  upstream_received: C.dim,
  response_intercepted: C.magenta,
  client_response: C.green,
  gateway_error: C.red,
};

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

// Local calendar day (YYYY-MM-DD). UTC would shift the filename for many timezones.
export function logDay(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Absolute path of the log file for the given day (the file may not exist yet).
export function currentLogFile(date = new Date()) {
  return path.resolve(config.logDir, `${logDay(date)}.log`);
}

function localTime(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function snippet(v, max = 80) {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === undefined) return '';
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

function shortId(id) {
  return typeof id === 'string' ? id.slice(0, 8) : '';
}

function statusOf(status) {
  if (status === undefined || status === null) return '-';
  const code = status >= 500 ? C.red : status >= 400 ? C.yellow : C.green;
  return paint(code, status);
}

// Pretty-print a JSON payload below the summary line. Long payloads are cut off;
// the log file always keeps the complete record.
function prettyJson(value) {
  let text;
  if (typeof value === 'string') {
    try {
      text = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      text = value;
    }
  } else {
    text = JSON.stringify(value, null, 2);
  }
  if (text === undefined) return '';
  return text.split('\n').map((line) => `  ${line}`).join('\n');
}

// Body may arrive as an object (incoming) or as a JSON string (outgoing).
function bodyObject(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' ? value : null;
}

// Truncate long content strings in messages for console display.
// Each message.content over MAX_CONTENT chars is cut; the JSONL file keeps the full record.
function truncateMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const out = { ...m };
    if (typeof out.content === 'string' && out.content.length > MAX_CONTENT) {
      out.content = `${out.content.slice(0, MAX_CONTENT)}\n... truncated (${out.content.length} chars total; see the log file)`;
    }
    return out;
  });
}

function formatDetails(entry) {
  const blocks = [];

  // ── Body metadata (console only — messages replaced with delta, tools omitted, JSONL keeps full record) ──
  // Skipped for upstream_request (redundant with client_request) and response_intercepted
  // (its content is shown below as a single field).
  if (entry.type !== 'upstream_request' && entry.type !== 'response_intercepted') {
    const body = bodyObject(entry.body);
    if (body) {
      const { tools, ...rest } = body;

      // Replace messages with the delta (new messages only) for console display.
      // On the first turn (reused=0) the delta IS the full history, so it looks the same.
      if (entry.delta && Array.isArray(rest.messages)) {
        const { delta, reused } = entry.delta;
        // Filter out the system prompt if it has already been seen (reused > 0)
        rest.messages = (reused > 0 && delta[0]?.role === 'system') ? delta.slice(1) : delta;
      }

      // Truncate long content strings per-message for console display.
      rest.messages = truncateMessages(rest.messages);

      // Truncate long top-level content strings (e.g. upstream_received response body).
      if (typeof rest.content === 'string' && rest.content.length > MAX_CONTENT) {
        rest.content = `${rest.content.slice(0, MAX_CONTENT)}\n... truncated (${rest.content.length} chars total; see the log file)`;
      }

      const bodyText = prettyJson(rest);
      if (bodyText) blocks.push(bodyText);
    }
  }

  // ── Delta context label — client_request only (other events repeat the same info) ──
  if (entry.delta && entry.type === 'client_request') {
    const { delta, total, reused } = entry.delta;
    const label = `delta (${delta.length} new / ${total} total, ${reused} already seen)`;
    blocks.push(`  ${paint(C.dim, label)}`);
  }

  // ── request_intercepted / response_intercepted: mutation status ──
  if (entry.changed !== undefined) {
    if (entry.changed) {
      const label = entry.type === 'response_intercepted' ? 'response (mutated)' : 'messages (mutated)';
      const value = entry.type === 'response_intercepted' ? entry.content : entry.messages;
      if (value !== undefined && value !== null) {
        const text = typeof value === 'string' ? JSON.stringify(value) : prettyJson(value);
        blocks.push(`  ${paint(C.dim, `${label}:`)}\n${text.split('\n').map((line) => `  ${line}`).join('\n')}`);
      }
    } else {
      const label = entry.type === 'response_intercepted' ? 'no response mutation applied' : 'no mutation applied';
      blocks.push(`  ${paint(C.dim, label)}`);
    }
  }

  return blocks.join('\n');
}

function formatConsole(entry) {
  const time = paint(C.dim, localTime(entry.ts));
  const type = paint(TYPE_STYLE[entry.type] ?? DEFAULT_TYPE_STYLE, entry.type.padEnd(19));
  const id = entry.id ? paint(C.dim, `id=${shortId(entry.id)}`) : '';
  let detail;

  switch (entry.type) {
    case 'gateway_start':
      detail = [
        `port=${entry.port}`,
        `upstream=${entry.upstream}`,
        `log=${entry.logFile ?? entry.logDir}`,
      ].join(' ');
      break;

    case 'client_request':
      detail = [
        paint(C.cyan, `${entry.method} ${entry.path}`),
        id,
      ].filter(Boolean).join(' ');
      break;

    case 'request_intercepted':
      detail = [
        `kind=${entry.kind}`,
        `count=${entry.count ?? '-'}`,
        entry.changed ? paint(C.yellow, 'changed=true') : 'changed=false',
        id,
      ].filter(Boolean).join(' ');
      break;

    case 'response_intercepted':
      detail = [
        entry.changed ? paint(C.yellow, 'changed=true') : 'changed=false',
        id,
      ].filter(Boolean).join(' ');
      break;

    case 'upstream_request':
      detail = [
        paint(C.blue, `${entry.method} ${entry.url}`),
        id,
      ].filter(Boolean).join(' ');
      break;

    case 'upstream_received':
      detail = [
        `status=${statusOf(entry.status)}`,
        entry.requestId ? `x-request-id=${snippet(entry.requestId, 40)}` : '',
        entry.contentType ? `type=${snippet(entry.contentType, 40)}` : '',
        id,
      ].filter(Boolean).join(' ');
      break;

    case 'client_response':
      detail = [
        `status=${statusOf(entry.status)}`,
        entry.stream ? paint(C.blue, 'stream') : 'json',
        entry.mutated ? paint(C.yellow, 'mutated') : '',
        entry.bytes !== undefined ? `${entry.bytes}B` : '',
        entry.content ? `content=${JSON.stringify(snippet(entry.content, 60))}` : '',
        entry.finishReason ? `finish=${entry.finishReason}` : '',
        entry.usage?.total_tokens !== undefined ? `tokens=${entry.usage.total_tokens}` : '',
        entry.completionId ? `completion=${shortId(entry.completionId)}` : '',
        id,
      ].filter(Boolean).join(' ');
      break;

    case 'gateway_error':
      detail = [
        paint(C.red, snippet(entry.message, 300)),
        id,
      ].filter(Boolean).join(' ');
      break;

    default:
      // Fallback for unknown event types (custom plugins, future events).
      // Show the whole entry as a one-line snippet so nothing is silently dropped.
      detail = snippet(entry, 120);
  }

  return `${time} ${type} ${detail}`;
}

/**
 * Log an event. Example types:
 *  client_request / request_intercepted / upstream_request /
 *  upstream_received / client_response / gateway_error
 */
export function logEvent(type, data) {
  const entry = { ts: new Date().toISOString(), type, ...data };

  // The delta is a console-only view helper; the JSONL file keeps the canonical full record.
  const { delta: _delta, ...fileEntry } = entry;
  const file = currentLogFile();
  try {
    fs.mkdirSync(config.logDir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(fileEntry) + '\n');
  } catch (err) {
    console.error(`failed to write log file ${file}: ${err.message}`);
  }

  // Errors are always shown; everything else only with --verbose.
  if (!verbose && type !== 'gateway_error') return;

  const line = formatConsole(entry);
  const details = formatDetails(entry);
  console.log(details ? `${line}\n${details}` : line);
}

const REDACT_HEADERS = new Set(['authorization', 'cookie', 'x-api-key', 'proxy-authorization']);

export function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = REDACT_HEADERS.has(k.toLowerCase()) ? `${String(v).slice(0, 8)}***` : v;
  }
  return out;
}
