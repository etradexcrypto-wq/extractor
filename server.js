'use strict';

require('dotenv').config();
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { extractEmails, extractFromFile } = require('./extractor');
const { scrapeUrl } = require('./scraper');

const app = express();
const SESSION_COOKIE = 'email_extractor_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const PIN = process.env.EXTRACTION_PIN || '79583';
const isProduction = process.env.NODE_ENV === 'production';
const signingSecret = process.env.AUTH_SECRET || (isProduction ? '' : crypto.randomBytes(32).toString('hex'));

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  });
  next();
});
app.use(express.json({ limit: '5mb', strict: true }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProduction ? '1h' : 0 }));

const attempts = new Map();
function rateLimit({ limit, windowMs }) {
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = attempts.get(key);
    if (!entry || entry.until <= now) entry = { count: 0, until: now + windowMs };
    entry.count += 1;
    attempts.set(key, entry);
    if (attempts.size > 5000) {
      for (const [ip, value] of attempts) if (value.until <= now) attempts.delete(ip);
    }
    if (entry.count > limit) return res.status(429).json({ error: 'Too many requests. Please wait and try again.' });
    next();
  };
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function sign(payload) {
  return crypto.createHmac('sha256', signingSecret).update(payload).digest('base64url');
}
function pinFingerprint() {
  return crypto.createHash('sha256').update(PIN).digest('base64url');
}
function makeSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS, pin: pinFingerprint() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => {
    const i = part.indexOf('=');
    return i < 0 ? ['', ''] : [part.slice(0, i).trim(), part.slice(i + 1).trim()];
  }).filter(([key]) => key));
}
function validSession(req) {
  if (!signingSecret) return false;
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE] || '';
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || !safeEqual(signature, sign(payload))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now() / 1000 && safeEqual(data.pin || '', pinFingerprint());
  }
  catch { return false; }
}
function requireSession(req, res, next) {
  if (!validSession(req)) return res.status(401).json({ error: 'Unlock with your extraction PIN to continue.' });
  next();
}
function checkSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
    } catch { return res.status(403).json({ error: 'Invalid request origin.' }); }
  }
  next();
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'email-extractor' }));
app.post('/api/auth', checkSameOrigin, rateLimit({ limit: 8, windowMs: 15 * 60 * 1000 }), (req, res) => {
  if (isProduction && !signingSecret) return res.status(503).json({ error: 'Deployment setup required: set AUTH_SECRET in the hosting environment.' });
  const supplied = typeof req.body?.pin === 'string' ? req.body.pin : '';
  if (!safeEqual(supplied, PIN)) return res.status(401).json({ error: 'That PIN is not correct.' });
  res.cookie(SESSION_COOKIE, makeSession(), {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_TTL_SECONDS * 1000
  });
  return res.json({ ok: true, expiresIn: SESSION_TTL_SECONDS });
});
app.get('/api/session', (req, res) => res.json({ authenticated: validSession(req) }));
app.post('/api/logout', checkSameOrigin, (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: isProduction, sameSite: 'strict', path: '/' });
  res.json({ ok: true });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 10, fields: 2, parts: 12 }
});
function mergeResults(map, emails, sources = {}) {
  for (const email of emails || []) {
    if (!map.has(email)) map.set(email, new Set());
    for (const source of sources[email] || []) map.get(email).add(source);
  }
}
function responseFrom(map, extra = {}) {
  const emails = [...map.keys()].sort();
  const sources = Object.fromEntries([...map].map(([email, values]) => [email, [...values]]));
  return { count: emails.length, emails, sources, ...extra };
}
function clamp(value, fallback, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.min(Math.floor(n), max)) : fallback;
}

app.post('/api/extract', checkSameOrigin, requireSession, rateLimit({ limit: 40, windowMs: 60 * 1000 }), async (req, res) => {
  try {
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Paste some text or enter a website URL.' });
    if (Buffer.byteLength(text, 'utf8') > 4_000_000) return res.status(413).json({ error: 'Text input is too large. Limit: 4 MB.' });
    if (/^https?:\/\//i.test(text.trim())) {
      const result = await scrapeUrl(text.trim(), clamp(req.body.maxPages, 5, 5));
      const map = new Map();
      mergeResults(map, result.emails, result.sources);
      return res.json(responseFrom(map, { pagesVisited: result.pagesVisited }));
    }
    const emails = extractEmails(text);
    const sources = Object.fromEntries(emails.map(email => [email, ['pasted text']]));
    const map = new Map();
    mergeResults(map, emails, sources);
    return res.json(responseFrom(map));
  } catch (err) {
    console.error('Text/URL extraction failed:', err.message);
    return res.status(400).json({ error: err.message || 'Could not scan that text or URL.' });
  }
});

app.post('/api/extract-files', checkSameOrigin, requireSession, rateLimit({ limit: 20, windowMs: 60 * 1000 }), upload.array('files', 10), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'Select at least one supported file.' });
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: 'Keep the combined file size under 4 MB (Vercel serverless request limit).' });
    }
    const results = [];
    const map = new Map();
    for (const file of files) {
      const result = await extractFromFile(file);
      mergeResults(map, result.emails, result.sources);
      results.push({ fileName: result.fileName, count: result.count, status: result.status, ...(result.error ? { error: result.error } : {}) });
    }
    return res.json(responseFrom(map, { totalFiles: files.length, files: results }));
  } catch (err) {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 4 MB or smaller.' : 'Upload limit reached. Use up to 10 files and 4 MB combined.';
      return res.status(400).json({ error: message });
    }
    console.error('File extraction failed:', err.message);
    return res.status(500).json({ error: 'File upload could not be processed.' });
  }
});

app.post('/api/extract-bulk', checkSameOrigin, requireSession, rateLimit({ limit: 10, windowMs: 60 * 1000 }), async (req, res) => {
  const rawUrls = req.body?.urls;
  if (!Array.isArray(rawUrls) || !rawUrls.length) return res.status(400).json({ error: 'Enter at least one website URL.' });
  if (rawUrls.length > 10) return res.status(400).json({ error: 'Scan up to 10 URLs per request.' });
  const urls = rawUrls.map(value => String(value).trim()).filter(Boolean);
  if (urls.some(value => !/^https?:\/\//i.test(value))) return res.status(400).json({ error: 'Every entry must start with http:// or https://.' });
  const map = new Map();
  const results = [];
  for (const url of urls) {
    try {
      const result = await scrapeUrl(url, clamp(req.body.maxPages, 3, 3));
      mergeResults(map, result.emails, result.sources);
      results.push({ url, count: result.emails.length, pagesVisited: result.pagesVisited });
    } catch (err) {
      results.push({ url, count: 0, error: err.message || 'Could not scan this URL.' });
    }
  }
  return res.json(responseFrom(map, { results }));
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 4 MB or smaller.' : 'Upload exceeds the supported limits.' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  console.error('Unhandled request error:', err?.message || err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Email Extractor running at http://localhost:${port}`));
}
module.exports = app;
