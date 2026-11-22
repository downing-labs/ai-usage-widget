'use strict';
// Throwaway proof listener: prints whatever the Gemini extension posts. Run: node test-listener.js
// (The real widget will own this port later.)
const http = require('http');

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      console.log(new Date().toISOString(), req.method, req.url);
      console.log(body);
      res.writeHead(204, { 'access-control-allow-origin': '*' });
      res.end();
    });
  })
  .listen(47831, '127.0.0.1', () => console.log('listening on http://127.0.0.1:47831'));
