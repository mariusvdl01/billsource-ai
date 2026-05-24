const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// Serve from same directory as this script — works wherever Railway puts files
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.txt':  'text/plain'
};

// Clean route → file mapping
const ROUTES = {
  '/':        'index.html',
  '/privacy': 'privacy.html',
  '/terms':   'terms.html',
  '/trust':   'trust.html',
};

http.createServer((req, res) => {
  // Strip query string
  const urlPath = req.url.split('?')[0];

  // 1. Check named routes first
  if (ROUTES[urlPath]) {
    const file = path.join(ROOT, ROUTES[urlPath]);
    fs.readFile(file, (err, data) => {
      if (err) { serve404(res); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // 2. Serve static assets (images, js, css etc)
  const filePath = path.join(ROOT, urlPath);
  const ext = path.extname(filePath).toLowerCase();

  // Security: prevent path traversal
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Unknown path — serve index (SPA-style fallback)
      fs.readFile(path.join(ROOT, 'index.html'), (err2, data2) => {
        if (err2) { serve404(res); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });

}).listen(PORT, () => {
  console.log(`BillSource AI running on port ${PORT}`);
  console.log(`Serving files from: ${ROOT}`);
  console.log(`Routes: ${Object.keys(ROUTES).join(', ')}`);
});

function serve404(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('404 Not found');
}
