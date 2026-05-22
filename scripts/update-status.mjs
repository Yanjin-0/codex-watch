import { writeFile } from 'node:fs/promises';

const TARGET_URLS = [
  'https://www.hascodexratelimitreset.today/',
  'https://hascodexratelimitreset.today/',
];

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
      return {
        ok: true,
        sourceUrl: targetUrl,
        fetchedAt: new Date().toISOString(),
        ...updated,
        ...parsed,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Unable to fetch upstream status');
}

const status = await fetchRemoteStatus().catch((error) => ({
  ok: false,
  sourceUrl: TARGET_URLS[0],
  fetchedAt: new Date().toISOString(),
  updatedAt: null,
  updatedAtText: null,
  updatedAtSource: null,
  state: 'unknown',
  verdictText: null,
  evidence: 'Unable to reach upstream site.',
  excerpt: [],
  rawText: '',
  error: error.message,
  stale: false,
}));

if (process.env.WRITE_STATUS_FILE === '1') {
  await writeFile(new URL('../public/status.json', import.meta.url), `${JSON.stringify(status, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify(status, null, 2));
