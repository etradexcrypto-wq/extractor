'use strict';

const $ = (id) => document.getElementById(id);
const state = { emails: [], sources: {} };
const supportedExt = /\.(pdf|docx|odt|ods|odp|odf|fodt|fods|fodp|txt|csv|tsv|html?|md|json|xml|png|jpe?g|gif|bmp|webp|tiff?)$/i;

function status(id, message = '', type = '') {
  const el = $(id);
  el.textContent = message;
  el.className = `status${type ? ` ${type}` : ''}`;
}
function setBusy(button, busy, label) {
  button.disabled = busy;
  if (busy) { button.dataset.label = button.innerHTML; button.textContent = label; }
  else if (button.dataset.label) { button.innerHTML = button.dataset.label; delete button.dataset.label; }
}
async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  let data;
  try { data = await response.json(); } catch { throw new Error(`Server returned an unreadable response (${response.status}).`); }
  if (!response.ok) {
    if (response.status === 401) showLocked();
    throw new Error(data.error || 'Request failed.');
  }
  return data;
}
function showLocked() {
  $('workspace').classList.add('hidden');
  $('lockScreen').classList.remove('hidden');
  $('logoutBtn').classList.add('hidden');
  $('pinInput').focus();
}
function showWorkspace() {
  $('lockScreen').classList.add('hidden');
  $('workspace').classList.remove('hidden');
  $('logoutBtn').classList.remove('hidden');
}
async function checkSession() {
  try { const session = await jsonRequest('/api/session'); if (session.authenticated) showWorkspace(); }
  catch { /* API or network unavailable; keep the PIN screen visible. */ }
}

$('pinForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('unlockBtn');
  setBusy(button, true, 'Checking PIN…');
  status('pinStatus', 'Verifying access…');
  try {
    await jsonRequest('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: $('pinInput').value }) });
    $('pinInput').value = '';
    status('pinStatus');
    showWorkspace();
  } catch (err) { status('pinStatus', err.message, 'error'); }
  finally { setBusy(button, false); }
});

$('logoutBtn').addEventListener('click', async () => {
  try { await jsonRequest('/api/logout', { method: 'POST' }); } catch {}
  showLocked();
  status('pinStatus', 'Workspace locked.');
});

function displayResults(data, meta = '') {
  state.emails = Array.isArray(data.emails) ? data.emails : [];
  state.sources = data.sources || {};
  $('resultsCard').classList.remove('hidden');
  $('resultCount').textContent = String(state.emails.length);
  $('resultMeta').textContent = meta;
  $('output').replaceChildren();
  if (!state.emails.length) {
    const empty = document.createElement('p'); empty.className = 'empty-results'; empty.textContent = 'No addresses from the allowed providers were found.'; $('output').append(empty); return;
  }
  for (const email of state.emails) {
    const row = document.createElement('div'); row.className = 'email-row';
    const info = document.createElement('div'); info.className = 'email-info';
    const address = document.createElement('strong'); address.textContent = email; info.append(address);
    const from = (state.sources[email] || []).join(' · ');
    if (from) { const source = document.createElement('small'); source.textContent = `Source: ${from}`; info.append(source); }
    const copy = document.createElement('button'); copy.className = 'copy-one'; copy.type = 'button'; copy.textContent = 'Copy';
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(email); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1100); } catch { copy.textContent = 'Select text'; } });
    row.append(info, copy); $('output').append(row);
  }
}

$('extractBtn').addEventListener('click', async () => {
  const text = $('textInput').value.trim();
  if (!text) return status('textStatus', 'Paste text or enter a public URL first.', 'error');
  const button = $('extractBtn'); setBusy(button, true, 'Extracting…'); status('textStatus', 'Scanning input…');
  try {
    const data = await jsonRequest('/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, maxPages: 5 }) });
    displayResults(data, data.pagesVisited ? `Scanned ${data.pagesVisited} page(s).` : 'Scanned pasted text.');
    status('textStatus', `${data.count} allowed email address(es) found.`, 'success');
  } catch (err) { status('textStatus', err.message, 'error'); }
  finally { setBusy(button, false); }
});
$('clearTextBtn').addEventListener('click', () => { $('textInput').value = ''; status('textStatus'); });
$('textInput').addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') $('extractBtn').click(); });

const fileInput = $('fileInput');
function updateFiles() {
  const files = [...fileInput.files];
  $('fileNames').textContent = files.length ? `${files.length} selected · ${files.map((f) => f.name).join(', ')}` : '';
}
fileInput.addEventListener('change', updateFiles);
const dropZone = $('dropZone');
for (const name of ['dragenter', 'dragover']) dropZone.addEventListener(name, (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
for (const name of ['dragleave', 'drop']) dropZone.addEventListener(name, (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); });
dropZone.addEventListener('drop', (e) => { const dropped = [...(e.dataTransfer?.files || [])]; if (dropped.length) { const transfer = new DataTransfer(); dropped.filter((file) => supportedExt.test(file.name)).forEach((file) => transfer.items.add(file)); fileInput.files = transfer.files; updateFiles(); } });

function renderFileTable(files) {
  const target = $('fileResults'); target.replaceChildren();
  if (!files.length) return;
  const table = document.createElement('table');
  const header = document.createElement('tr');
  for (const label of ['File', 'Found', 'Status']) { const th = document.createElement('th'); th.textContent = label; header.append(th); }
  const thead = document.createElement('thead'); thead.append(header); table.append(thead);
  const body = document.createElement('tbody');
  for (const file of files) {
    const row = document.createElement('tr');
    for (const value of [file.fileName, file.count, file.error || file.status]) { const td = document.createElement('td'); td.textContent = String(value ?? ''); row.append(td); }
    body.append(row);
  }
  table.append(body); target.append(table);
}
$('uploadBtn').addEventListener('click', async () => {
  const files = [...fileInput.files];
  if (!files.length) return status('fileStatus', 'Choose at least one supported file.', 'error');
  if (files.length > 10) return status('fileStatus', 'Choose up to 10 files at a time.', 'error');
  if (files.reduce((sum, file) => sum + file.size, 0) > 4 * 1024 * 1024) return status('fileStatus', 'Combined upload size must be 4 MB or less.', 'error');
  const form = new FormData(); files.forEach((file) => form.append('files', file));
  const button = $('uploadBtn'); setBusy(button, true, 'Scanning files…'); status('fileStatus', 'Uploading and reading files. Image OCR may take longer.');
  try {
    const data = await jsonRequest('/api/extract-files', { method: 'POST', body: form });
    displayResults(data, `Found across ${data.totalFiles} file(s).`); renderFileTable(data.files || []);
    status('fileStatus', `${data.count} allowed email address(es) across ${data.totalFiles} file(s).`, 'success');
  } catch (err) { status('fileStatus', err.message, 'error'); }
  finally { setBusy(button, false); }
});

$('bulkBtn').addEventListener('click', async () => {
  const urls = $('bulkInput').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!urls.length) return status('bulkStatus', 'Enter at least one public website URL.', 'error');
  if (urls.length > 10) return status('bulkStatus', 'Scan up to 10 URLs per request.', 'error');
  const button = $('bulkBtn'); setBusy(button, true, 'Scanning websites…'); status('bulkStatus', `Scanning ${urls.length} website(s)…`);
  try {
    const data = await jsonRequest('/api/extract-bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls, maxPages: 3 }) });
    displayResults(data, `Scanned ${data.results.length} website(s).`);
    const failed = data.results.filter((result) => result.error).length;
    status('bulkStatus', `${data.count} allowed email(s) found · ${failed} site(s) could not be read.`, 'success');
  } catch (err) { status('bulkStatus', err.message, 'error'); }
  finally { setBusy(button, false); }
});

$('copyBtn').addEventListener('click', async () => {
  if (!state.emails.length) return;
  try { await navigator.clipboard.writeText(state.emails.join('\n')); $('copyBtn').textContent = 'Copied'; setTimeout(() => { $('copyBtn').textContent = 'Copy all'; }, 1200); }
  catch { status('textStatus', 'Clipboard access failed. You can select and copy the results.', 'error'); }
});
$('downloadBtn').addEventListener('click', () => {
  if (!state.emails.length) return;
  const blob = new Blob([state.emails.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = `emails-${new Date().toISOString().slice(0, 10)}.txt`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

checkSession();
