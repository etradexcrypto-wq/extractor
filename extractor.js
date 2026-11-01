'use strict';

const path = require('node:path');
const os = require('node:os');
// Make pdf-parse's optional canvas integration visible to Vercel's file tracer.
require('@napi-rs/canvas');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const JSZip = require('jszip');

const ALLOWED_DOMAINS = new Set(['yahoo.com', 'aol.com', 'gmail.com', 'hotmail.com', 'icloud.com']);
const EMAIL_RE = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const MAX_UNZIPPED_BYTES = 12 * 1024 * 1024;

function decodeEntities(value) {
  return String(value || '').replace(/&(#x[\da-f]+|#\d+|commat|period|dot|amp|lt|gt|quot|apos);/gi, (entity, code) => {
    const key = code.toLowerCase();
    if (key === 'commat') return '@';
    if (key === 'period' || key === 'dot') return '.';
    if (key === 'amp') return '&';
    if (key === 'lt') return '<';
    if (key === 'gt') return '>';
    if (key === 'quot') return '"';
    if (key === 'apos') return "'";
    if (key.startsWith('#x')) return String.fromCodePoint(parseInt(key.slice(2), 16));
    if (key.startsWith('#')) return String.fromCodePoint(parseInt(key.slice(1), 10));
    return entity;
  }).replace(/%40/gi, '@').replace(/%2e/gi, '.');
}

function normalizeText(value) {
  return decodeEntities(value)
    .replace(/\s*[\[({]\s*at\s*[\])}]\s*/gi, '@')
    .replace(/\s+at\s+/gi, '@')
    .replace(/\s*[\[({]\s*dot\s*[\])}]\s*/gi, '.')
    .replace(/\s+dot\s+/gi, '.')
    .replace(/\s*\(at\)\s*/gi, '@');
}

function isAllowedEmail(candidate) {
  const email = candidate.toLowerCase();
  if (email.length > 254 || email.length < 6) return false;
  const at = email.lastIndexOf('@');
  if (at < 1 || at !== email.indexOf('@')) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return false;
  if (!/^[a-z0-9.-]+$/.test(domain) || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  return ALLOWED_DOMAINS.has(domain);
}

function extractEmails(input) {
  const normalized = normalizeText(input);
  const found = new Set();
  let match;
  while ((match = EMAIL_RE.exec(normalized)) !== null) {
    const clean = match[0].replace(/[.,;:!?)}\]>]+$/g, '').toLowerCase();
    if (isAllowedEmail(clean)) found.add(clean);
  }
  EMAIL_RE.lastIndex = 0;
  return [...found].sort();
}

function xmlToText(xml) {
  return decodeEntities(String(xml || '')
    .replace(/<text:[^>]*>/gi, ' ')
    .replace(/<\/text:[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' '));
}

async function parseOpenDocument(buffer) {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: false });
  const entries = Object.values(zip.files).filter(file => !file.dir && /(?:^|\/)(?:content|meta|styles)\.xml$/i.test(file.name));
  const uncompressed = entries.reduce((total, entry) => total + (entry._data?.uncompressedSize || 0), 0);
  if (uncompressed > MAX_UNZIPPED_BYTES) throw new Error('OpenDocument contents are too large to process safely.');
  const parts = await Promise.all(entries.map(entry => entry.async('string')));
  return parts.map(xmlToText).join('\n');
}

let ocrWorkerPromise;
async function extractImageText(buffer) {
  try {
    const { createWorker } = require('tesseract.js');
    if (!ocrWorkerPromise) ocrWorkerPromise = createWorker('eng', undefined, { cachePath: os.tmpdir() });
    const worker = await ocrWorkerPromise;
    const result = await worker.recognize(buffer);
    return result.data?.text || '';
  } catch (err) {
    ocrWorkerPromise = null;
    throw new Error(`Image OCR could not run: ${err.message}`);
  }
}

async function extractFileText(file) {
  const name = file.originalname || 'uploaded-file';
  const ext = path.extname(name).toLowerCase();
  const buffer = file.buffer;
  if (!buffer?.length) throw new Error('The uploaded file is empty.');

  if (ext === '.pdf') {
    const parser = new PDFParse({ data: buffer });
    try {
      const parsed = await parser.getText();
      return parsed.text || '';
    } finally {
      await parser.destroy();
    }
  }
  if (ext === '.docx') {
    const parsed = await mammoth.extractRawText({ buffer });
    return parsed.value || '';
  }
  if (['.odt', '.ods', '.odp', '.odf'].includes(ext)) return parseOpenDocument(buffer);
  if (['.fodt', '.fods', '.fodp'].includes(ext)) return xmlToText(buffer.toString('utf8'));
  if (['.txt', '.csv', '.tsv', '.html', '.htm', '.md', '.json', '.xml'].includes(ext)) return buffer.toString('utf8');
  if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff'].includes(ext)) return extractImageText(buffer);
  throw new Error('Unsupported file type. Use PDF, DOCX, ODF, TXT/CSV/HTML/JSON/XML, or an image.');
}

async function extractFromFile(file) {
  const name = file.originalname || 'uploaded-file';
  try {
    const text = await extractFileText(file);
    const emails = extractEmails(text);
    return { fileName: name, count: emails.length, status: 'ok', emails, sources: Object.fromEntries(emails.map(email => [email, [name]])) };
  } catch (err) {
    return { fileName: name, count: 0, status: 'error', error: err.message || 'Could not read this file.', emails: [], sources: {} };
  }
}

module.exports = { ALLOWED_DOMAINS: [...ALLOWED_DOMAINS], extractEmails, extractFileText, extractFromFile, parseOpenDocument, isAllowedEmail };
