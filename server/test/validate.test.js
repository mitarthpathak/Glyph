import test from 'node:test';
import assert from 'node:assert/strict';
import { amountsDiffer, lowConfidenceIssues, validateExtraction } from '../lib/validate.js';
import { normalizeExtraction } from '../lib/extract.js';
import { finalizeExtraction } from '../lib/pipeline.js';
import { certificateDoc, invoiceDoc, marksheetDoc } from './helpers/docs.js';

const now = new Date('2025-01-15T00:00:00Z');
const run = doc => validateExtraction(doc, { now });
const find = (issues, re) => issues.find(i => re.test(i.message));

test('a correct invoice has no issues', () => {
  assert.deepEqual(run(invoiceDoc()), []);
});

test('invoice: total mismatch and missing GSTIN are flagged as errors', () => {
  const issues = run(invoiceDoc({ total: 'Rs. 1,250.00', gstin: null }));
  const total = find(issues, /Total ₹1,250 does not match/);
  assert.equal(total.severity, 'error');
  assert.equal(total.type, 'inconsistent');
  assert.ok(total.fieldKeys.includes('total_amount'));
  const missing = find(issues, /Seller GSTIN is missing/);
  assert.equal(missing.severity, 'error');
  assert.equal(missing.type, 'missing');
  assert.equal(issues[0].severity, 'error', 'errors first');
});

test('invoice: line items, qty × rate, tax split, GST rate and due date', () => {
  let issues = run(invoiceDoc({ rows: [['Notebook', '10', '50.00', '500.00'], ['Pen set', '5', '100.00', '450.00'], ['Total', '', '', '950.00']] }));
  assert.equal(find(issues, /Line items add up to ₹950/).severity, 'error');
  assert.equal(find(issues, /5 × ₹100 = ₹500, but the amount shown is ₹450/).severity, 'warning');
  assert.ok(!find(issues, /Line item 3/), 'total rows are not items');

  issues = run(invoiceDoc({ fields: [{ key: 'sgst', value: 'Rs. 80.00', confidence: 0.9 }] }));
  assert.ok(find(issues, /CGST .* and SGST .* should be equal/));
  assert.ok(find(issues, /does not equal CGST \+ SGST/));

  issues = run(invoiceDoc({ fields: [{ key: 'due_date', value: '01/03/2024', confidence: 0.9 }] }));
  assert.equal(find(issues, /Due date .* is before the invoice date/).severity, 'error');

  const odd = normalizeExtraction({ docType: 'invoice', fields: [
    { key: 'subtotal', value: '1000' }, { key: 'tax_total', value: '150' }, { key: 'total_amount', value: '1150' },
  ] });
  assert.equal(find(run(odd), /not a standard GST rate/).severity, 'info');
});

test('invoice: invalid GSTIN and PAN formats are warnings', () => {
  const issues = run(invoiceDoc({ gstin: '27ABCDE1234F1X5', fields: [{ key: 'seller_pan', value: 'ABCD1234F' }] }));
  assert.equal(find(issues, /Seller GSTIN .* not a valid GSTIN/).severity, 'warning');
  assert.equal(find(issues, /Seller PAN .* not a valid PAN/).type, 'format');
  const mismatch = run(invoiceDoc({ fields: [{ key: 'seller_pan', value: 'ZZZZZ9999Z' }] }));
  assert.ok(find(mismatch, /PAN in the GSTIN/));
});

test('marksheet: correct one passes; wrong total, wrong percentage and pass/fail are flagged', () => {
  assert.deepEqual(run(marksheetDoc()), []);
  let issues = run(marksheetDoc({ total: '420', percentage: '84' }));
  assert.equal(find(issues, /Subject marks add up to 412, but the total shown is 420/).severity, 'error');
  assert.ok(!find(issues, /Percentage/), '84% matches the (wrong) total of 420');

  issues = run(marksheetDoc({ percentage: '86.5' }));
  assert.equal(find(issues, /Percentage 86.5% does not match 412 \/ 500 = 82.40%/).severity, 'error');

  issues = run(marksheetDoc({
    total: '312', percentage: '62.4',
    rows: [['English', '100', '85'], ['Hindi', '100', '20'], ['Mathematics', '100', '90'], ['Science', '100', '39'], ['Social Science', '100', '78']],
  }));
  assert.ok(find(issues, /Result is PASS, but 1 subject/));
  issues = run(marksheetDoc({ result: 'FAIL' }));
  assert.ok(find(issues, /Result is FAIL/));
  issues = run(marksheetDoc({ rows: [['English', '100', '105'], ['Hindi', '100', '78'], ['Mathematics', '100', '90'], ['Science', '100', '81'], ['Social Science', '100', '58']] }));
  assert.ok(find(issues, /English: marks obtained \(105\) exceed the maximum/));
});

test('certificate: issue date after expiry is an error; spelling variants are warnings', () => {
  assert.deepEqual(run(certificateDoc()), []);
  const issues = run(certificateDoc({ issue: '20/08/2024', valid: '19/08/2023' }));
  const order = find(issues, /Valid until \(2023-08-19\) is before issue date/);
  assert.equal(order.severity, 'error');
  assert.deepEqual(order.fieldKeys, ['issue_date', 'valid_until']);
  assert.ok(find(issues, /has passed; the document has expired/));

  const names = run(certificateDoc({ entities: [{ type: 'PERSON', value: 'Rohan Mehtaa' }, { type: 'PERSON', value: 'Rohan Mehta' }, { type: 'PERSON', value: 'Dr. S. Iyer' }] }));
  const variant = find(names, /written differently: "Rohan Mehta" and "Rohan Mehtaa"/);
  assert.equal(variant.severity, 'warning');
  assert.deepEqual(variant.fieldKeys, ['recipient_name']);
  assert.equal(names.filter(i => /written differently/.test(i.message)).length, 1);
});

test('general: future dates, impossible birth dates, duplicated IDs, unmasked Aadhaar', () => {
  const doc = normalizeExtraction({ docType: 'application_form', docTypeConfidence: 0.9, fields: [
    { key: 'form_title', value: 'Admission Form' }, { key: 'applicant_name', value: 'Neha Rao' },
    { key: 'application_date', value: '10/10/2030' }, { key: 'date_of_birth', value: '01/01/2031' },
    { key: 'application_number', value: 'APP-77' }, { key: 'id_number', value: 'APP-77' },
    { key: 'aadhaar_number', label: 'Aadhaar number', value: '1234 5678 9012' },
    { key: 'email', value: 'neha(at)example' }, { key: 'phone', value: '12345' }, { key: 'pincode', value: '011001' },
  ] });
  const issues = run(doc);
  assert.equal(find(issues, /Application date .* is in the future/).severity, 'warning');
  assert.equal(find(issues, /Date of birth .* is in the future/).severity, 'error');
  assert.ok(find(issues, /same number \(APP-77\)/));
  assert.ok(find(issues, /full Aadhaar number/));
  assert.ok(find(issues, /not a valid email/));
  assert.ok(find(issues, /not a valid phone/));
  assert.ok(find(issues, /not a valid PINCODE/));
  assert.ok(!find(issues, /applicant name is missing/i));
});

test('uncertain document type is reported as info', () => {
  const issues = run(normalizeExtraction({ docType: 'other', docTypeConfidence: 0.3, fields: [] }));
  assert.equal(find(issues, /document type is uncertain/).type, 'low_confidence');
});

test('low-confidence issues for required fields below 0.5', () => {
  const issues = lowConfidenceIssues([
    { key: 'a', label: 'A', required: true, value: 'x', confidence: 0.42 },
    { key: 'b', label: 'B', required: true, value: 'y', confidence: 0.9 },
    { key: 'c', label: 'C', required: false, value: 'z', confidence: 0.1 },
    { key: 'd', label: 'D', required: true, value: null, confidence: 0 },
  ]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, 'low_confidence');
  assert.deepEqual(issues[0].fieldKeys, ['a']);
});

test('pipeline: issues feed the confidence score and the overall score', () => {
  const text = ['invoice_number: INV-1 invoice_date: 12/03/2024 seller_name: Example Traders Pvt Ltd buyer_name: Sample Retail Co subtotal: Rs. 1,000.00 total_amount: Rs. 1,250.00'];
  const good = finalizeExtraction(invoiceDoc({ total: 'Rs. 1,250.00' }), { textByPage: text, ocrUsed: false, now });
  const total = good.fields.find(f => f.key === 'total_amount');
  assert.equal(total.confidenceDetail.validation, 0, 'error on the field lowers its validation score');
  assert.ok(good.issues.some(i => i.type === 'inconsistent'));
  assert.ok(good.overallConfidence < 0.9);
  assert.ok(amountsDiffer(100, 102) && !amountsDiffer(100, 100.5));
});
