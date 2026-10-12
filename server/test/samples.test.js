// End-to-end over the synthetic samples in samples/: the real API, text
// extraction, validation, confidence scoring and search, with Gemini replaced
// by the canned answers in test/fixtures/gemini/sample-*.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeGemini } from './helpers/fakeGemini.js';

process.env.MONGO_URI = '';
process.env.GEMINI_API_KEY = '';
process.env.AUTH_SECRET = 'test-secret';
process.env.VERCEL = '1';

const { default: app } = await import('../index.js');
const { setGeminiClient } = await import('../lib/ai.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(() => server.close());

const samples = JSON.parse(readFileSync(new URL('../../samples/manifest.json', import.meta.url)));
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/gemini/${name}`, import.meta.url)));
const typeOf = file => (file.endsWith('.jpg') ? 'image/jpeg' : 'application/pdf');

const signup = await fetch(base + '/auth/signup', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: `samples${Date.now()}@example.com`, password: 'secret12', phone: '1', age: 20 }),
});
const auth = { authorization: `Bearer ${(await signup.json()).token}` };

const results = {};
for (const s of samples) {
  const { _match, ...answer } = fixture(s.fixture);
  const fake = fakeGemini([{ json: answer }]);
  setGeminiClient(fake);
  const fd = new FormData();
  fd.append('files', new Blob([readFileSync(new URL(`../../samples/${s.file}`, import.meta.url))], { type: typeOf(s.file) }), s.file);
  const r = await fetch(base + '/extract', { method: 'POST', body: fd, headers: auth });
  results[s.file[0]] = { status: r.status, doc: (await r.json()).documents[0], calls: fake.calls };
  setGeminiClient(null);
}
const doc = k => results[k].doc;
const issue = (k, re) => doc(k).issues.find(i => re.test(i.message));

test('every sample is extracted with a type, a summary and sourced fields', () => {
  const expected = { a: 'invoice', b: 'invoice', c: 'certificate', d: 'marksheet', e: 'application_form', f: 'identity_document', g: 'institutional_record', h: 'report', i: 'identity_document', j: 'invoice' };
  for (const [k, type] of Object.entries(expected)) {
    assert.equal(results[k].status, 200, k);
    assert.equal(doc(k).docType, type, k);
    assert.ok(doc(k).docTypeConfidence >= 0.9, `${k} type confidence`);
    assert.ok(doc(k).summary.length > 40, `${k} summary`);
    assert.equal(results[k].calls.length, 1, `${k}: one Gemini call`);
    for (const f of doc(k).fields.filter(x => x.value != null)) {
      assert.ok(f.page >= 1 && f.sourceQuote, `${k}.${f.key} has page and quote`);
      assert.ok(['high', 'medium', 'low'].includes(f.confidenceBand), `${k}.${f.key} band`);
    }
  }
});

test('digital PDFs use the text layer; scans, photos and the garbled Hindi PDF use OCR', () => {
  for (const k of ['a', 'b', 'c', 'd', 'h']) {
    assert.equal(doc(k).ocrUsed, false, k);
    assert.ok(!results[k].calls[0].contents[0].parts.some(p => p.inlineData), `${k} sends text only`);
  }
  assert.equal(doc('e').ocrUsed, true);
  assert.equal(results.e.calls[0].contents[0].parts[1].inlineData.mimeType, 'image/jpeg');
  assert.equal(doc('f').ocrUsed, true);
  assert.equal(doc('f').textLayer, 'scanned');
  assert.equal(doc('g').ocrUsed, true, 'garbled Hindi text layer: file attached');
  assert.ok(results.g.calls[0].contents[0].parts.some(p => p.inlineData));
});

test('a correct digital invoice verifies with high confidence and no errors', () => {
  const a = doc('a');
  assert.ok(a.overallConfidence >= 0.9, `overall ${a.overallConfidence}`);
  assert.equal(a.issueCounts.error, 0, JSON.stringify(a.issues));
  const total = a.fields.find(f => f.key === 'total_amount');
  assert.equal(total.normalizedValue, 18880);
  assert.equal(total.confidenceBand, 'high');
  assert.equal(total.confidenceDetail.quoteFound, true);
});

test('planted problems are flagged with the right severity', () => {
  const total = issue('b', /Total ₹11,710 does not match ₹9,500 \+ tax ₹1,710 = ₹11,210/);
  assert.equal(total?.severity, 'error');
  assert.equal(issue('b', /Seller GSTIN is missing/)?.severity, 'error');

  assert.equal(issue('c', /Valid until \(2023-08-19\) is before issue date \(2024-08-20\)/)?.severity, 'error');
  assert.equal(issue('c', /written differently: "Rohan Mehta" and "Rohan Mehtaa"/)?.severity, 'warning');

  assert.equal(issue('d', /Subject marks add up to 408, but the total shown is 418/)?.severity, 'error');
  assert.ok(!issue('d', /Percentage/), '83.60% is consistent with the printed 418/500');

  for (const k of ['a', 'e', 'f', 'g', 'h', 'i', 'j']) assert.equal(doc(k).issueCounts.error, 0, `${k}: ${JSON.stringify(doc(k).issues)}`);
});

test('OCR values are capped at 0.90 and the Hindi notice verifies against the transcription', () => {
  for (const k of ['e', 'f']) assert.ok(doc(k).fields.every(f => f.confidence <= 0.9), k);
  const subject = doc('g').fields.find(f => f.key === 'title_or_subject');
  assert.equal(subject.confidenceDetail.quoteFound, true);
  assert.ok(subject.confidence > 0.5);
});

test('search finds Hindi and English text across the samples, with filters', async () => {
  const search = async params => (await (await fetch(`${base}/search?${new URLSearchParams(params)}`, { headers: auth })).json()).results;
  let hits = await search({ q: 'परीक्षा' });
  assert.equal(hits[0].docType, 'institutional_record');
  hits = await search({ q: 'GSTIN' });
  assert.ok(hits.length && hits.every(h => h.docType === 'invoice'));
  hits = await search({ q: 'Rohan' });
  assert.equal(hits[0].docType, 'certificate');
  hits = await search({ q: 'Example', type: 'report' });
  assert.ok(hits.length && hits.every(h => h.docType === 'report'));
  hits = await search({ q: 'Arjun', minConfidence: '0.95' });
  assert.equal(hits.length, 0, 'OCR values are capped at 0.90');
});

test('cross-document checks find exactly the planted conflicts between samples', async () => {
  const r = await (await fetch(`${base}/crosscheck`, { headers: auth })).json();
  const got = r.issues.map(i => `${i.severity}:${i.rule}`).sort();
  assert.deepEqual(got, ['error:cross.dob_mismatch', 'error:cross.invoice_conflict', 'warning:cross.father_mismatch'], JSON.stringify(r.issues, null, 1));
  const dob = r.issues.find(i => i.rule === 'cross.dob_mismatch');
  assert.deepEqual(dob.refs.map(x => x.documentId).sort(), [doc('d').id, doc('i').id].sort());
  assert.match(dob.message, /Roll no\. 2401587/);
  const inv = r.issues.find(i => i.rule === 'cross.invoice_conflict');
  assert.match(inv.message, /Invoice ET\/2024-25\/0147 from Example Traders Pvt Ltd .* ₹18,880 .* ₹18,762/);
  // Per document: only the issues that involve it.
  const forCert = await (await fetch(`${base}/crosscheck?documentId=${doc('c').id}`, { headers: auth })).json();
  assert.equal(forCert.count, 0);
  const forId = await (await fetch(`${base}/crosscheck?documentId=${doc('i').id}`, { headers: auth })).json();
  assert.equal(forId.count, 2);
  assert.equal((await fetch(`${base}/crosscheck?documentId=nope`, { headers: auth })).status, 404);
});
