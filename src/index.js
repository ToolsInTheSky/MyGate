// Clear the screen before any output so the log stream is easy to read.
console.clear();

import fs from 'node:fs';

import { createApp } from './app.js';
import { config } from './config.js';
import { logEvent, currentLogFile, setVerbose } from './logger.js';

// ── Opt-in plugin hooks ──────────────────────────────────────────────────
// If hooks/index.js exists, it is loaded before the app starts so that any
// addRequestMutation / addResponseMutation calls it makes are registered in time.
// The file is optional: the gateway runs without it and no error is raised.
// Resolved relative to this module's location (src/index.js → ../hooks/index.js),
// so it works regardless of the process working directory.
const hooksPath = new URL('../hooks/index.js', import.meta.url);
if (fs.existsSync(hooksPath)) {
  await import(hooksPath.href);
}

// --verbose / -v or VERBOSE=true in .env: stream per-request logs to this console
const verbose = process.argv.slice(2).some((arg) => arg === '--verbose' || arg === '-v') || process.env.VERBOSE === 'true';
setVerbose(verbose);

const app = createApp();

app.listen(config.port, () => {
  logEvent('gateway_start', {
    port: config.port,
    upstream: config.upstreamBaseUrl,
    logDir: config.logDir,
    logFile: currentLogFile(),
  });
  console.log(`OpenAI-compatible gateway listening on http://localhost:${config.port}`);
  console.log(`upstream: ${config.upstreamBaseUrl}`);
  console.log(`log file: ${currentLogFile()}`);
  if (verbose) {
    console.log('per-request logs: ON. Only messages added since the previous turn of a session are shown.');
  } else {
    console.log('per-request logs: OFF. Stream them to this console with `npm start -- --verbose` or VERBOSE=true in .env');
  }
});