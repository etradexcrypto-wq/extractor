'use strict';

process.env.NODE_ENV = 'test';
process.env.EXTRACTION_PIN = '79583';
process.env.AUTH_SECRET = 'test-only-signing-secret-that-is-long-enough';

const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { extractEmails, parseOpenDocument } = require('../extractor');
const { assertPublicUrl, isPrivateAddress } = require('../scraper');
const app = require('../server');

const sample = 'Contact 1019italytx76651dcelis74@gmail.com, 207-229-7865dirtdigger207@gmail.com, valid.name@yahoo.com and person@icloud.com. Ignore user@company.org, fake@gmail.com.example, test@gmail.com, and a@aol.com.';

test('extracts only valid addresses at the five allowed provider domains', () => {
  assert.deepEqual(extractEmails(sample), [
    '1019italytx76651dcelis74@gmail.com',
    '207-229-7865dirtdigger207@gmail.com',
    'a@aol.com',
    'person@icloud.com',
    'test@gmail.com',
    'valid.name@yahoo.com'
  ]);
});

test('normalizes case, HTML entities, and common obfuscation', () => {
  assert.deepEqual(extractEmails('HELLO [at] GMAIL [dot] COM &lt;team&#64;hotmail.com&gt;'), [
    'hello@gmail.com', 'team@hotmail.com'
  ]);
});

test('reads email text inside an ODF archive', async () => {
  const zip = new JSZip();
  zip.file('content.xml', '<office:document><text:p>service@aol.com</text:p></office:document>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  assert.match(await parseOpenDocument(bytes), /service@aol\.com/);
});

test('rejects private and local website targets', async () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('10.20.30.40'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  await assert.rejects(assertPublicUrl('http://127.0.0.1'), /Private or local/);
  await assert.rejects(assertPublicUrl('http://localhost'), /Private or local/);
});

test('API requires a verified PIN session before extraction', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const denied = await fetch(`${base}/api/extract`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: sample })
  });
  assert.equal(denied.status, 401);
  const badLogin = await fetch(`${base}/api/auth`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '00000' })
  });
  assert.equal(badLogin.status, 401);
  const login = await fetch(`${base}/api/auth`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '79583' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${base}/api/extract`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ text: sample })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.count, 6);
  assert.equal(data.emails.includes('user@company.org'), false);
});
