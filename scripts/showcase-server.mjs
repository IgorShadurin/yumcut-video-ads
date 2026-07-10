import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = resolve(process.env.SHOWCASE_DIR || resolve(projectRoot, 'showcase-dist'));
const host = process.env.HOST || '0.0.0.0';
const port = Number.parseInt(process.env.PORT || '3000', 10);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

const contentTypes = new Map([
  ['.avif', 'image/avif'],
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.otf', 'font/otf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.ttf', 'font/ttf'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.xml', 'application/xml; charset=utf-8'],
]);

const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' https: blob: data:; connect-src 'self' https: blob:; worker-src 'self' blob:; child-src 'self' blob:",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
};

function send(response, status, body, headers = {}) {
  response.writeHead(status, { ...securityHeaders, ...headers });
  response.end(body);
}

function cacheControl(pathname) {
  if (pathname === '/nextjs/vendor/yumcut-render-worker.js') {
    return 'no-cache, no-store, must-revalidate';
  }
  if (/^\/(?:nextjs|react|vanilla)\/(?:_next\/static|assets)\//.test(pathname)) {
    return 'public, max-age=31536000, immutable';
  }
  if (/^\/(?:nextjs|react|vanilla)?\/?media\//.test(pathname)) {
    return 'public, max-age=86400, must-revalidate';
  }
  return 'no-cache';
}

function safePath(pathname) {
  const candidate = resolve(publicRoot, `.${pathname}`);
  if (candidate !== publicRoot && !candidate.startsWith(`${publicRoot}${sep}`)) return null;
  return candidate;
}

function existingFile(pathname) {
  const candidate = safePath(pathname);
  if (!candidate) return null;
  try {
    const stats = statSync(candidate);
    if (stats.isFile()) return { path: candidate, stats };
    if (stats.isDirectory()) {
      const index = resolve(candidate, 'index.html');
      const indexStats = statSync(index);
      if (indexStats.isFile()) return { path: index, stats: indexStats };
    }
  } catch {
    return null;
  }
  return null;
}

function fallback(pathname) {
  const protectedRoute =
    /^\/nextjs\/(?:_next|media|vendor)\//.test(pathname)
    || /^\/(?:react|vanilla)\/(?:assets|media)\//.test(pathname)
    || /^\/media\//.test(pathname);
  if (protectedRoute) return null;
  for (const prefix of ['/nextjs/', '/react/', '/vanilla/']) {
    if (pathname.startsWith(prefix)) return existingFile(`${prefix}index.html`);
  }
  return null;
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!match || (match[1] === '' && match[2] === '')) return null;

  let start;
  let end;
  if (match[1] === '') {
    const suffixLength = Number.parseInt(match[2], 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    end = match[2] === '' ? size - 1 : Number.parseInt(match[2], 10);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

function serveFile(request, response, pathname, file) {
  const headers = {
    ...securityHeaders,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl(pathname),
    'Content-Type': contentTypes.get(extname(file.path).toLowerCase()) || 'application/octet-stream',
    'Last-Modified': file.stats.mtime.toUTCString(),
  };

  const rangeHeader = request.headers.range;
  const range = rangeHeader ? parseRange(rangeHeader, file.stats.size) : null;
  if (rangeHeader && !range) {
    send(response, 416, '', {
      ...headers,
      'Content-Range': `bytes */${file.stats.size}`,
    });
    return;
  }

  if (range) {
    const length = range.end - range.start + 1;
    response.writeHead(206, {
      ...headers,
      'Content-Length': String(length),
      'Content-Range': `bytes ${range.start}-${range.end}/${file.stats.size}`,
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file.path, range).pipe(response);
    return;
  }

  response.writeHead(200, { ...headers, 'Content-Length': String(file.stats.size) });
  if (request.method === 'HEAD') response.end();
  else createReadStream(file.path).pipe(response);
}

const server = createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(response, 405, 'Method not allowed\n', {
      Allow: 'GET, HEAD',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
  } catch {
    send(response, 400, 'Bad request\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  if (pathname === '/healthz') {
    send(response, 200, 'ok\n', {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return;
  }

  if (['/nextjs', '/react', '/vanilla', '/media'].includes(pathname)) {
    response.writeHead(308, { ...securityHeaders, Location: `${pathname}/` });
    response.end();
    return;
  }

  const file = existingFile(pathname) || fallback(pathname);
  if (!file) {
    send(response, 404, 'Not found\n', {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return;
  }
  serveFile(request, response, pathname, file);
});

server.listen(port, host, () => {
  console.log(`YumCut showcase listening on http://${host}:${port}`);
});

function shutdown() {
  server.close((error) => {
    if (error) throw error;
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
