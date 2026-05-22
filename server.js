const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const TARGET_URLS = [
  'https://www.hascodexratelimitreset.today/',
  'https://hascodexratelimitreset.today/',
];
const TARGET_URL = TARGET_URLS[0];
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_TTL_MS = 15_000;

let cachedStatus = null;
let cachedAt = 0;
let inFlight = null;

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/manifest+json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x2F;/gi, '/');
}

function htmlToText(html) {
  const withoutBlocks = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|div|section|article|main|header|footer|li|ul|ol|h[1-6]|tr|td|th|blockquote|pre|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return decodeEntities(
    withoutBlocks
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n')
  );
}

function parseUpdatedAt(response, text) {
  const header = response.headers.get('last-modified');
  if (header) {
    const parsed = new Date(header);
    if (!Number.isNaN(parsed.getTime())) {
      return {
        updatedAt: parsed.toISOString(),
        updatedAtText: header,
        updatedAtSource: 'last-modified-header',
      };
    }
  }

  const normalized = text.replace(/\s+/g, ' ').trim();
  const patterns = [
    /Last Yes verdict seen:\s*(.+?)(?:\s+(?:Last @|Verdict:|TOKENS USED:|$))/i,
    /Last @[\w.-]+ tweet seen at:\s*(.+?)(?:\s+(?:Verdict:|TOKENS USED:|$))/i,
    /(?:Last updated|Updated at|Published at):\s*(.+?)(?:\s+(?:Verdict:|TOKENS USED:|$))/i,
    /(?:Last updated|Updated at|Published at)\s+(.+?)(?:\s+(?:Verdict:|TOKENS USED:|$))/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;

    const candidate = match[1].trim();
    if (/^\d{1,2}:\d{2}:\d{2}\s+ago$/i.test(candidate) || /^\d+\s+(?:second|minute|hour|day)s?\s+ago$/i.test(candidate)) {
      return {
        updatedAt: null,
        updatedAtText: candidate,
        updatedAtSource: 'page-text-relative',
      };
    }

    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) {
      return {
        updatedAt: parsed.toISOString(),
        updatedAtText: candidate,
        updatedAtSource: 'page-text',
      };
    }

    return {
      updatedAt: null,
      updatedAtText: candidate,
      updatedAtSource: 'page-text',
    };
  }

  return {
    updatedAt: null,
    updatedAtText: null,
    updatedAtSource: null,
  };
}

function parseStatusFromText(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const normalized = lines.join(' ');

  const verdictIndex = lines.findIndex((line) => /^Verdict$/i.test(line));
  let verdictSnippet = null;
  let verdictText = null;
  if (verdictIndex >= 0) {
    const nearby = lines.slice(verdictIndex + 1, verdictIndex + 5);
    const nearbyMatch = nearby.join(' ').match(/\b(Yes|No)\b/i);
    if (nearbyMatch) {
      verdictText = nearbyMatch[1].toLowerCase();
      verdictSnippet = `Verdict: ${nearbyMatch[1]}`;
    }
  }

  if (!verdictText) {
    const explicitMatch = normalized.match(/\bVerdict:\s*(Yes|No)\b/i);
    if (explicitMatch) {
      verdictText = explicitMatch[1].toLowerCase();
      verdictSnippet = `Verdict: ${explicitMatch[1]}`;
    }
  }

  const lastYesLine = lines.find((line) => /^Last Yes verdict seen:/i.test(line));
  const lastYesValue = lastYesLine ? lastYesLine.replace(/^Last Yes verdict seen:\s*/i, '').trim() : '';

  let state = 'unknown';
  if (verdictText === 'yes') {
    state = 'yes';
  } else if (verdictText === 'no') {
    state = 'no';
  } else if (lastYesValue && !/awaiting reset/i.test(lastYesValue)) {
    state = 'yes';
  } else if (/awaiting reset/i.test(normalized) || /no classification yet/i.test(normalized)) {
    state = 'no';
  }

  const evidence =
    verdictSnippet ||
    lastYesLine ||
    lines.find((line) => /^Last @/.test(line)) ||
    lines.find((line) => /Verdict/i.test(line)) ||
    lines.slice(0, 20).join(' · ');

  return {
    state,
    verdictText,
    evidence,
    excerpt: lines.slice(0, 24),
    rawText: text.slice(0, 4000),
  };
}

async function fetchRemoteStatus() {
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    let lastError = null;

    for (const targetUrl of TARGET_URLS) {
      try {
        const response = await fetch(targetUrl, {
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CodexResetWatch/1.0',
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(12_000),
        });

        if (!response.ok) {
          throw new Error(`Upstream returned ${response.status}`);
      }

      const html = await response.text();
      const text = htmlToText(html);
      const parsed = parseStatusFromText(text);
      const updated = parseUpdatedAt(response, text);
      const payload = {
        ok: true,
        sourceUrl: targetUrl,
        fetchedAt: new Date().toISOString(),
        ...updated,
        ...parsed,
      };
        cachedStatus = payload;
        cachedAt = Date.now();
        return payload;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('Unable to fetch upstream status');
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

function networkUrls(port) {
  const urls = [`http://localhost:${port}`];
  const seen = new Set(urls);

  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces || []) {
      if (!item || item.family !== 'IPv4' || item.internal) {
        continue;
      }
      const url = `http://${item.address}:${port}`;
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
  }

  return urls;
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }

  try {
    const data = await fs.promises.readFile(filePath);
    res.writeHead(200, {
      'content-type': contentType(filePath),
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/status' || url.pathname === '/status.json') {
      const now = Date.now();
      let status = cachedStatus;

      if (!status || now - cachedAt > CACHE_TTL_MS) {
        try {
          status = await fetchRemoteStatus();
        } catch (error) {
          status = {
            ok: false,
            sourceUrl: cachedStatus?.sourceUrl || TARGET_URL,
            fetchedAt: new Date().toISOString(),
            updatedAt: cachedStatus?.updatedAt || null,
            updatedAtText: cachedStatus?.updatedAtText || null,
            updatedAtSource: cachedStatus?.updatedAtSource || null,
            state: cachedStatus?.state || 'unknown',
            verdictText: cachedStatus?.verdictText || null,
            evidence: cachedStatus?.evidence || 'Unable to reach upstream site.',
            excerpt: cachedStatus?.excerpt || [],
            rawText: cachedStatus?.rawText || '',
            error: error.message,
            stale: Boolean(cachedStatus),
          };
        }
      }

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(JSON.stringify(status));
      return;
    }

    if (url.pathname === '/api/meta') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(
        JSON.stringify({
            port: PORT,
            host: HOST,
            urls: networkUrls(PORT),
            targetUrl: TARGET_URL,
          })
      );
      return;
    }

    if (url.pathname === '/manifest.webmanifest' || url.pathname === '/sw.js' || url.pathname === '/icon.svg' || url.pathname === '/index.html' || url.pathname === '/') {
      await serveStatic(req, res, url.pathname);
      return;
    }

    await serveStatic(req, res, url.pathname);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Server error: ${error.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Codex Reset Watch running at http://localhost:${PORT}`);
  for (const url of networkUrls(PORT).slice(1)) {
    console.log(`LAN access: ${url}`);
  }
});
