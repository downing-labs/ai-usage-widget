'use strict';

const http = require('http');
const crypto = require('crypto');

/**
 * Local bridge for the Gemini Chrome companion. Listens on 127.0.0.1 only, and only while Gemini is
 * switched on. Every request must pass authorize(): a Chrome-extension origin (never a web page), a
 * loopback Host header (blocks DNS rebinding), and the shared token.
 */

const DEFAULT_PORT = 47831;
const MAX_BODY_BYTES = 8192;

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

// Pure: headers + expected token -> { ok: true } | { ok: false, status }.
function authorize(headers, token, port = DEFAULT_PORT) {
  const origin = headers.origin;
  if (origin && !String(origin).startsWith('chrome-extension://')) return { ok: false, status: 403 };
  const host = String(headers.host || '');
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return { ok: false, status: 403 };
  const m = /^Bearer (.+)$/.exec(String(headers.authorization || ''));
  if (!token || !m || !safeEqual(m[1], token)) return { ok: false, status: 401 };
  return { ok: true };
}

function createBridge({ port = DEFAULT_PORT, getToken, onReport, onError, log = () => {} }) {
  let server = null;

  function handle(req, res) {
    const auth = authorize(req.headers, getToken(), port);
    if (!auth.ok) {
      res.writeHead(auth.status);
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.method === 'POST' && req.url === '/report') {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          res.writeHead(413);
          res.end();
          req.destroy();
        } else {
          chunks.push(c);
        }
      });
      req.on('end', () => {
        if (res.writableEnded) return;
        try {
          onReport(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          res.writeHead(204);
        } catch {
          res.writeHead(400);
        }
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  }

  return {
    start() {
      if (server) return;
      server = http.createServer(handle);
      server.on('error', (err) => {
        log(`bridge error: ${err.code || err.message}`);
        if (onError) onError(err.code === 'EADDRINUSE' ? `Port ${port} is in use` : 'Companion bridge failed to start');
        server = null;
      });
      server.listen(port, '127.0.0.1', () => log(`bridge listening on 127.0.0.1:${port}`));
    },
    stop() {
      if (!server) return;
      server.close();
      server = null;
      log('bridge stopped');
    },
  };
}

module.exports = { createBridge, authorize, newToken, DEFAULT_PORT };
