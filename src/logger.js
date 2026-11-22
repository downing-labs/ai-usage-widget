'use strict';

const fs = require('fs');
const path = require('path');

// Prototype logger: one file, rotated by size, never logs credentials.
const ROTATE_BYTES = 5 * 1024 * 1024;
const SENSITIVE_KEYS = ['cookie', 'token', 'session', 'password', 'authorization'];

let logsDir = null;
let activeFile = null;
let debugMode = false;

function redact(message) {
  let out = String(message);
  for (const key of SENSITIVE_KEYS) {
    const re = new RegExp(`(${key}[\\w-]*["']?\\s*[:=]\\s*["']?)([^"'\\s,}]+)`, 'gi');
    out = out.replace(re, '$1[REDACTED]');
  }
  return out;
}

function init(userDataPath, { debug = false } = {}) {
  debugMode = debug;
  logsDir = path.join(userDataPath, 'logs');
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    activeFile = path.join(logsDir, 'latest.log');
  } catch (err) {
    console.error('[logger] cannot create logs dir:', err.message);
  }
}

function write(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${redact(message)}\n`;
  process.stdout.write(line);
  if (!activeFile) return;
  try {
    if (fs.existsSync(activeFile) && fs.statSync(activeFile).size > ROTATE_BYTES) {
      fs.renameSync(activeFile, path.join(logsDir, `${Date.now()}.log`));
    }
    fs.appendFileSync(activeFile, line, 'utf-8');
  } catch (err) {
    console.error('[logger] write failed:', err.message);
  }
}

const log = (m) => write('INFO', m);
const debugLog = (m) => { if (debugMode) write('DEBUG', m); };
const getLogsDir = () => logsDir;

module.exports = { init, log, debugLog, getLogsDir };
