/**
 * @file serve-static.js
 * @description Minimal static file server for the mock UI, on Node's
 *              built-in `http` – all the e2e suite needs, without a
 *              dependency tree. Usage: node scripts/serve-static.js <dir> <port>
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || 'mock-ui');
const port = Number(process.argv[3] || 5555);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

http
  .createServer((req, res) => {
    let file;
    try {
      file = path.resolve(root, `.${decodeURIComponent(new URL(req.url, 'http://localhost').pathname)}`);
    } catch {
      return res.writeHead(400).end('Bad request');
    }
    // Never serve anything outside the mock-ui directory.
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end('Forbidden');
    fs.readFile(file, (err, body) => {
      if (err) return res.writeHead(404).end('Not found');
      res
        .writeHead(200, {
          'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        })
        .end(body);
    });
  })
  .listen(port, '127.0.0.1');
