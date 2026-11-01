'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const { extractEmails } = require('./extractor');

const MAX_HTML_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 8_000;
const REDIRECT_LIMIT = 3;

function isPrivateAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const p = address.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && (p[1] === 168 || p[1] === 0)) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19 || p[1] === 51)) ||
      (p[0] === 203 && p[1] === 0 && p[2] === 113) || p[0] >= 224;
  }
  if (version === 6) {
    const a = address.toLowerCase();
    if (a.startsWith('::ffff:')) return isPrivateAddress(a.slice(7));
    return a === '::' || a === '::1' || a.startsWith('fc') || a.startsWith('fd') ||
      /^fe[89ab]/.test(a) || a.startsWith('2001:db8:');
  }
  return true;
}

async function assertPublicUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('Please provide a valid website URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only public HTTP or HTTPS website URLs are supported.');
  }
  if ((url.protocol === 'http:' && url.port && url.port !== '80') ||
      (url.protocol === 'https:' && url.port && url.port !== '443')) {
    throw new Error('Non-standard website ports are not supported.');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host.endsWith('.test') || host.endsWith('.invalid')) {
    throw new Error('Private or local network URLs are not allowed.');
  }
  const literal = net.isIP(host);
  const addresses = literal ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Private or local network URLs are not allowed.');
  }
  return url;
}

async function readLimited(response, maxBytes) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new Error('Website page is too large to scan.');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('Website page is too large to scan.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchPublicPage(input) {
  let current = input;
  for (let hop = 0; hop <= REDIRECT_LIMIT; hop++) {
    const url = await assertPublicUrl(current);
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'User-Agent': 'EmailExtractor/2.0 (+public page text extraction)',
        'Accept': 'text/html,text/plain;q=0.9,*/*;q=0.1'
      }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || hop === REDIRECT_LIMIT) throw new Error('Website redirected too many times.');
      current = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) throw new Error(`Website responded with HTTP ${response.status}.`);
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !/(text\/html|application\/xhtml\+xml|text\/plain)/.test(contentType)) {
      throw new Error('That URL does not return a readable HTML or text page.');
    }
    return { url, html: await readLimited(response, MAX_HTML_BYTES) };
  }
  throw new Error('Could not load the website.');
}

function getSameOriginLinks(html, pageUrl, limit) {
  const origin = new URL(pageUrl).origin;
  const links = [];
  const seen = new Set();
  const hrefRe = /\bhref\s*=\s*(["'])(.*?)\1/gi;
  let match;
  while ((match = hrefRe.exec(html)) && links.length < limit * 4) {
    const raw = match[2].replace(/&amp;/gi, '&');
    try {
      const u = new URL(raw, pageUrl);
      u.hash = '';
      if (u.origin !== origin || !['http:', 'https:'].includes(u.protocol)) continue;
      if (!/\/$/.test(u.pathname) && /\.(?:pdf|jpe?g|png|gif|webp|zip|docx?|xlsx?|pptx?)(?:$|\/)/i.test(u.pathname)) continue;
      const key = u.toString();
      if (!seen.has(key)) { seen.add(key); links.push(key); }
    } catch {}
  }
  const priority = /contact|about|support|help|team|company|legal/i;
  return links.sort((a, b) => Number(priority.test(b)) - Number(priority.test(a))).slice(0, limit);
}

async function scrapeUrl(input, maxPages = 5) {
  const start = await assertPublicUrl(input);
  const cap = Math.max(1, Math.min(Number(maxPages) || 5, 5));
  const queue = [start.toString()];
  const visited = new Set();
  const emailSources = new Map();
  const origin = start.origin;

  while (queue.length && visited.size < cap) {
    const target = queue.shift();
    if (visited.has(target)) continue;
    visited.add(target);
    try {
      const { url, html } = await fetchPublicPage(target);
      const matches = extractEmails(html);
      for (const email of matches) {
        if (!emailSources.has(email)) emailSources.set(email, new Set());
        emailSources.get(email).add(url);
      }
      if (visited.size === 1) {
        for (const link of getSameOriginLinks(html, url, cap - 1)) {
          if (new URL(link).origin === origin && !visited.has(link) && !queue.includes(link)) queue.push(link);
        }
      }
    } catch (err) {
      if (visited.size === 1) throw err;
    }
  }

  return {
    emails: [...emailSources.keys()].sort(),
    sources: Object.fromEntries([...emailSources].map(([email, set]) => [email, [...set]])),
    pagesVisited: visited.size
  };
}

module.exports = { scrapeUrl, assertPublicUrl, isPrivateAddress };
