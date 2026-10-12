import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makePdf } from './helpers/files.js';
import { fakeGemini } from './helpers/fakeGemini.js';
import { startFakeSupabase } from './helpers/fakeSupabase.js';

process.env.MONGO_URI = '';
process.env.GEMINI_API_KEY = '';
process.env.AUTH_SECRET = 'test-secret';
process.env.VERCEL = '1';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { default: app } = await import('../index.js');
const { setGeminiClient } = await import('../lib/ai.js');
const { updateJobItem } = await import('../lib/db.js');
const { resetStorageForTests } = await import('../lib/storage.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(() => server.close());

const invoice = JSON.parse(readFileSync(new URL('./fixtures/gemini/invoice.json', import.meta.url)));
const invoicePdf = (tag = Math.random()) => makePdf([[
  'TAX INVOICE', 'Invoice No: INV-2024-0042', 'Date: 12/03/2024', 'Seller: Example Traders Pvt Ltd', 'GSTIN: 27AAACE1234F1Z6',
  'Bill To: Sample Retail Co', 'Subtotal: Rs. 1,000.00', 'GST 18%: Rs. 180.00', 'Total: Rs. 1,180.00', `Ref ${tag}`,
]]);

const guest = () => ({ 'x-guest-id': `g${Date.now()}${Math.random().toString(36).slice(2)}aaaaaaaaaaaa`.slice(0, 40) });
const json = (headers, body) => ({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const call = async (path, init = {}) => {
  const r = await fetch(base + path, init);
  return { status: r.status, body: await r.json().catch(() => null) };
};

async function directUpload(headers, bytes, name = 'invoice.pdf', type = 'application/pdf') {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), name);
  return call('/uploads', { method: 'POST', body: fd, headers });
}

async function waitForJob(headers, id, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await call(`/jobs/${id}`, { headers });
    if (body.job.status !== 'running') return body.job;
    if (Date.now() > until) throw new Error(`job still running: ${JSON.stringify(body.job)}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

test('uploads and jobs need an owner (account or guest workspace)', async () => {
  assert.equal((await call('/uploads/sign', json({}, { filename: 'a.pdf' }))).status, 401);
  assert.equal((await call('/jobs', json({}, { items: [] }))).status, 401);
  assert.equal((await call('/jobs/abc')).status, 401);
  // Malformed guest ids are ignored.
  assert.equal((await call('/jobs/abc', { headers: { 'x-guest-id': 'short' } })).status, 401);
});

test('direct mode: upload, queue a job, poll it to completion, open the document', async () => {
  const g = guest();
  setGeminiClient(fakeGemini([{ json: invoice }]));
  try {
    const sign = await call('/uploads/sign', json(g, { filename: 'invoice.pdf', mimeType: 'application/pdf', size: 1000 }));
    assert.equal(sign.status, 200);
    assert.equal(sign.body.mode, 'direct', 'without Supabase the file goes to the API');

    const bytes = invoicePdf();
    const up = await directUpload(g, bytes);
    assert.equal(up.status, 200);
    assert.match(up.body.path, /^uploads\/g_/);
    assert.equal(up.body.driver, 'memory');

    const created = await call('/jobs', json(g, { items: [{ path: up.body.path, filename: 'invoice.pdf', mimeType: 'application/pdf', size: bytes.length, quality: { width: 10, blurScore: 0.2, junk: { nested: 1 } } }] }));
    assert.equal(created.status, 202);
    assert.equal(created.body.job.total, 1);

    const job = await waitForJob(g, created.body.job.id);
    assert.equal(job.status, 'done');
    const item = job.items[0];
    assert.equal(item.progress, 100);
    assert.ok(item.documentId);

    const doc = await call(`/documents/${item.documentId}`, { headers: g });
    assert.equal(doc.status, 200);
    assert.equal(doc.body.docType, 'invoice');
    // Other guests and anonymous requests cannot see it.
    assert.equal((await call(`/documents/${item.documentId}`, { headers: guest() })).status, 404);
    assert.equal((await call(`/documents/${item.documentId}`)).status, 401);
    assert.equal((await call(`/jobs/${created.body.job.id}`, { headers: guest() })).status, 404);

    // The original is stored for the page preview.
    const fileUrl = await call(`/documents/${item.documentId}/file-url`, { headers: g });
    assert.equal(fileUrl.body.external, false);
    const file = await fetch(`http://127.0.0.1:${server.address().port}${fileUrl.body.url}`, { headers: g });
    assert.equal(file.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(bytes));
  } finally {
    setGeminiClient(null);
  }
});

test('jobs only accept files the same owner uploaded', async () => {
  const a = guest();
  const b = guest();
  const up = await directUpload(a, invoicePdf());
  const stolen = await call('/jobs', json(b, { items: [{ path: up.body.path, filename: 'x.pdf' }] }));
  assert.equal(stolen.status, 403);
  assert.equal((await call('/jobs', json(a, { items: [{ path: `${up.body.path}/../../x`, filename: 'x.pdf' }] }))).status, 403);
  assert.equal((await call('/jobs', json(a, { items: Array.from({ length: 11 }, () => ({ path: up.body.path })) }))).status, 400);
});

test('a failing file fails its item only; bad files are rejected at upload', async () => {
  const g = guest();
  const fake = await directUpload(g, Buffer.from('not a pdf'), 'fake.pdf');
  assert.equal(fake.status, 400);
  assert.match(fake.body.error, /not a valid PDF/);

  // A scanned PDF without the AI cannot be read: that item fails with a clear message.
  const scan = await directUpload(g, makePdf([[], []]), 'scan.pdf');
  const ok = await directUpload(g, invoicePdf());
  // The AI answers text requests and is "busy" for files (the scan), whichever comes first.
  setGeminiClient({ models: { async generateContent(req) {
    if (req.contents[0].parts.some(p => p.inlineData)) throw Object.assign(new Error('UNAVAILABLE'), { status: 503 });
    return { text: JSON.stringify(invoice), modelVersion: req.model };
  } } });
  try {
    const created = await call('/jobs', json(g, { items: [
      { path: ok.body.path, filename: 'ok.pdf', mimeType: 'application/pdf' },
      { path: scan.body.path, filename: 'scan.pdf', mimeType: 'application/pdf' },
    ] }));
    const job = await waitForJob(g, created.body.job.id);
    assert.equal(job.status, 'partial');
    const failed = job.items.find(i => i.status === 'failed');
    assert.equal(failed.filename, 'scan.pdf');
    assert.match(failed.error, /no selectable text/);
    assert.ok(job.items.find(i => i.status === 'done').documentId);
  } finally {
    setGeminiClient(null);
  }
});

test('a poll resumes an item whose worker died (expired lease)', async () => {
  const g = guest();
  const up = await directUpload(g, invoicePdf());
  // No AI and a digital PDF: the rule-based fallback finishes quickly.
  const created = await call('/jobs', json(g, { items: [{ path: up.body.path, filename: 'inv.pdf', mimeType: 'application/pdf' }] }));
  const id = created.body.job.id;
  await waitForJob(g, id);
  // Pretend the worker died mid-way: running with an expired lease.
  const itemId = created.body.job.items[0].id;
  await updateJobItem(id, itemId, { status: 'running', stage: 'extracting', leaseUntil: new Date(Date.now() - 1000), attempts: 1, documentId: null });
  const job = await waitForJob(g, id);
  assert.equal(job.status, 'done');
  assert.ok(job.items[0].documentId);

  // A second death after the retry: the item fails instead of looping.
  await updateJobItem(id, itemId, { status: 'running', leaseUntil: new Date(Date.now() - 1000), attempts: 2 });
  const failed = await waitForJob(g, id);
  assert.equal(failed.items[0].status, 'failed');
  assert.match(failed.items[0].error, /took too long/);
});

test('signing in claims the guest workspace', async () => {
  const g = guest();
  const up = await directUpload(g, invoicePdf());
  const created = await call('/jobs', json(g, { items: [{ path: up.body.path, filename: 'mine.pdf', mimeType: 'application/pdf' }] }));
  const job = await waitForJob(g, created.body.job.id);
  const signup = await call('/auth/signup', json({}, { email: `c${Date.now()}@example.com`, password: 'secret12', phone: '1', age: 30 }));
  const auth = { authorization: `Bearer ${signup.body.token}` };
  const claim = await call('/guest/claim', { method: 'POST', headers: { ...auth, ...g } });
  assert.equal(claim.body.moved, 1);
  const list = await call('/documents', { headers: auth });
  assert.deepEqual(list.body.documents.map(d => d.id), [job.items[0].documentId]);
  assert.equal((await call(`/documents/${job.items[0].documentId}`, { headers: g })).status, 404, 'no longer in the guest workspace');
});

test('supabase mode: signed direct upload, processing from storage, signed read URL', async () => {
  const sb = startFakeSupabase();
  process.env.SUPABASE_URL = sb.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = sb.serviceKey;
  resetStorageForTests();
  const g = guest();
  setGeminiClient(fakeGemini([{ json: invoice }]));
  try {
    const health = await call('/health');
    assert.equal(health.body.fileStorage, 'supabase');

    const bytes = invoicePdf();
    const sign = await call('/uploads/sign', json(g, { filename: 'big invoice.pdf', mimeType: 'application/pdf', size: 20 * 1024 * 1024 }));
    assert.equal(sign.status, 200, 'files above 4 MB are fine when they go straight to storage');
    assert.equal(sign.body.mode, 'supabase');
    assert.ok(sb.buckets.has('glyph-documents'), 'bucket created on first use');
    assert.equal((await call('/uploads/sign', json(g, { filename: 'huge.pdf', mimeType: 'application/pdf', size: 60 * 1024 * 1024 }))).status, 413);

    // The browser PUTs the bytes to the signed URL (no API involved).
    const put = await fetch(sign.body.uploadUrl, { method: 'PUT', headers: sign.body.headers, body: bytes });
    assert.equal(put.status, 200);

    const created = await call('/jobs', json(g, { items: [{ path: sign.body.path, filename: 'big invoice.pdf', mimeType: 'application/pdf', size: bytes.length }] }));
    const job = await waitForJob(g, created.body.job.id);
    assert.equal(job.status, 'done', JSON.stringify(job));

    const fileUrl = await call(`/documents/${job.items[0].documentId}/file-url`, { headers: g });
    assert.equal(fileUrl.body.external, true);
    const file = await fetch(fileUrl.body.url);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(bytes));

    // Deleting the document deletes the stored original.
    assert.equal(sb.objects.size, 1);
    await call(`/documents/${job.items[0].documentId}`, { method: 'DELETE', headers: g });
    assert.equal(sb.objects.size, 0);
  } finally {
    setGeminiClient(null);
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    resetStorageForTests();
    sb.close();
  }
});
