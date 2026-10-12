/**
 * Detection of missing and inconsistent information in an extraction.
 * Pure functions: input is a normalised extraction (see extract.js), output
 * a list of issues:
 *   { severity: 'error'|'warning'|'info',
 *     type: 'missing'|'inconsistent'|'format'|'low_confidence',
 *     fieldKeys: string[], message: string }
 */
import { FORMATS, isValidPhone, parseAmount, parseDate, parseNumber } from './normalize.js';
import { looseText } from './confidence.js';
import { checkAadhaar, checkPan, checkVid, gstinCheckChar, gstinChecksumValid, maskAadhaar } from './idchecks.js';

// Below this the value is flagged for review.
export const LOW_CONFIDENCE = 0.5;
const GST_RATES = [0, 0.05, 0.12, 0.18, 0.28];
// Dates that may legitimately lie in the future.
const FUTURE_OK = new Set(['due_date', 'valid_until', 'expiry_date', 'deadline_date', 'effective_date']);
// Typical minimum pass mark per subject (CBSE / most state boards).
const PASS_SHARE = 0.33;

const issue = (severity, type, fieldKeys, message) => ({ severity, type, fieldKeys, message });
const fmtAmount = n => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const fmtNum = n => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** Amounts differ by more than ₹1 and 0.5 %. */
export const amountsDiffer = (a, b) => Math.abs(a - b) > Math.max(1, 0.005 * Math.max(Math.abs(a), Math.abs(b)));

function fieldMap(extraction) {
  const map = new Map(extraction.fields.map(f => [f.key, f]));
  const num = key => {
    const f = map.get(key);
    if (!f || f.value == null) return null;
    if (typeof f.normalizedValue === 'number') return f.normalizedValue;
    return f.type === 'amount' ? parseAmount(f.value) : parseNumber(f.value);
  };
  const date = key => {
    const f = map.get(key);
    return f && f.value != null ? (f.type === 'date' && f.normalizedValue) || parseDate(f.value) : null;
  };
  const label = key => map.get(key)?.label || key;
  return { map, num, date, label };
}

// ─── Required fields and formats ─────────────────────────────────────
function missingIssues(extraction) {
  return extraction.fields
    .filter(f => f.required && f.value == null)
    .map(f => issue('error', 'missing', [f.key], `${f.label} is missing.`));
}

function formatIssues(extraction) {
  const out = [];
  for (const f of extraction.fields) {
    if (f.value == null) continue;
    const n = f.normalizedValue;
    // Aadhaar / VID numbers are checked in idNumberIssues.
    if (f.format === 'aadhaar' || /aadhaar|aadhar|\bvid\b|virtual id/i.test(`${f.key} ${f.label}`)) continue;
    if (f.format && FORMATS[f.format] && !FORMATS[f.format].test(String(n ?? ''))) {
      out.push(issue('warning', 'format', [f.key], `${f.label} "${f.value}" is not a valid ${f.format.toUpperCase()} format.`));
    } else if (f.format === 'gstin') {
      const state = Number(String(n).slice(0, 2));
      if (state < 1 || state > 38) out.push(issue('warning', 'format', [f.key], `${f.label} "${f.value}" has an unknown state code (${String(n).slice(0, 2)}).`));
    }
    if (f.type === 'date' && n == null) out.push(issue('warning', 'format', [f.key], `${f.label} "${f.value}" is not a readable date.`));
    if (f.type === 'amount' && n == null && parseAmount(f.value) == null) out.push(issue('warning', 'format', [f.key], `${f.label} "${f.value}" is not a readable amount.`));
    if (f.type === 'number' && n == null && parseNumber(f.value) == null) out.push(issue('warning', 'format', [f.key], `${f.label} "${f.value}" is not a number.`));
    if (f.type === 'email' && n == null) out.push(issue('warning', 'format', [f.key], `${f.label} "${f.value}" is not a valid email address.`));
    if (f.type === 'phone' && !isValidPhone(f.value)) out.push(issue('warning', 'format', [f.key], `${f.label} "${f.value}" is not a valid phone number.`));
  }
  return out;
}

// ─── Tables ──────────────────────────────────────────────────────────
function findColumn(table, include, exclude) {
  for (let i = table.columns.length - 1; i >= 0; i--) {
    const c = table.columns[i];
    if (include.test(c) && !(exclude && exclude.test(c))) return i;
  }
  return -1;
}
const cellNumber = (row, i) => (i >= 0 ? parseAmount(row[i]) : null);
// Rows such as "Total" or "Grand total" inside a table are summaries, not items.
const isSummaryRow = row => /\b(sub\s*-?\s*total|grand\s*total|total|कुल|net amount|amount payable)\b/i.test(row.slice(0, 2).join(' '));

// ─── Invoice ─────────────────────────────────────────────────────────
function invoiceIssues(extraction, { num, date, label }) {
  const out = [];
  const subtotal = num('subtotal');
  const total = num('total_amount');
  const discount = num('discount') || 0;
  const cgst = num('cgst');
  const sgst = num('sgst');
  const igst = num('igst');
  const parts = [cgst, sgst, igst].filter(v => v != null);
  const taxFromParts = parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  const taxTotal = num('tax_total');
  const tax = taxTotal ?? taxFromParts;

  // Line items vs subtotal.
  const items = extraction.tables.find(t => findColumn(t, /amount|total|value|₹|rs/i, /tax|gst|rate|qty|quantity/i) >= 0 && t.rows.length);
  if (items) {
    const amountCol = findColumn(items, /amount|total|value|₹|rs/i, /tax|gst|rate|qty|quantity/i);
    const qtyCol = findColumn(items, /qty|quantity|units?|nos/i);
    const rateCol = findColumn(items, /rate|price|unit cost/i, /tax|gst/i);
    let sum = 0;
    let counted = 0;
    items.rows.forEach((row, r) => {
      if (isSummaryRow(row)) return;
      const amount = cellNumber(row, amountCol);
      if (amount == null) return;
      sum += amount;
      counted++;
      const qty = cellNumber(row, qtyCol);
      const rate = cellNumber(row, rateCol);
      if (qty != null && rate != null && amountsDiffer(qty * rate, amount)) {
        out.push(issue('warning', 'inconsistent', [], `Line item ${r + 1} (${row[0] || 'item'}): ${fmtNum(qty)} × ${fmtAmount(rate)} = ${fmtAmount(qty * rate)}, but the amount shown is ${fmtAmount(amount)}.`));
      }
    });
    const target = subtotal ?? (tax == null && !discount ? total : null);
    const targetKey = subtotal != null ? 'subtotal' : 'total_amount';
    if (counted && target != null && amountsDiffer(sum, target)) {
      out.push(issue('error', 'inconsistent', [targetKey], `Line items add up to ${fmtAmount(sum)}, but ${label(targetKey).toLowerCase()} is ${fmtAmount(target)}.`));
    }
  }

  if (subtotal != null && total != null) {
    const expected = subtotal + (tax || 0) - discount;
    if (amountsDiffer(expected, total)) {
      const formula = `${fmtAmount(subtotal)}${tax ? ` + tax ${fmtAmount(tax)}` : ''}${discount ? ` − discount ${fmtAmount(discount)}` : ''}`;
      out.push(issue('error', 'inconsistent', ['total_amount', 'subtotal', 'tax_total'].filter(k => k !== 'tax_total' || tax != null),
        `Total ${fmtAmount(total)} does not match ${formula} = ${fmtAmount(expected)}.`));
    }
  }
  if (taxTotal != null && taxFromParts != null && amountsDiffer(taxTotal, taxFromParts)) {
    out.push(issue('warning', 'inconsistent', ['tax_total', 'cgst', 'sgst', 'igst'].filter(k => num(k) != null),
      `Total tax ${fmtAmount(taxTotal)} does not equal CGST + SGST + IGST = ${fmtAmount(taxFromParts)}.`));
  }
  if (cgst != null && sgst != null && amountsDiffer(cgst, sgst)) {
    out.push(issue('warning', 'inconsistent', ['cgst', 'sgst'], `CGST (${fmtAmount(cgst)}) and SGST (${fmtAmount(sgst)}) should be equal.`));
  }
  if (igst && (cgst || sgst)) {
    out.push(issue('warning', 'inconsistent', ['igst', 'cgst', 'sgst'], 'IGST is charged together with CGST/SGST; an invoice normally has one or the other.'));
  }
  if (subtotal && tax != null) {
    const base = subtotal - discount;
    const rate = base > 0 ? tax / base : 0;
    if (base > 0 && !GST_RATES.some(r => Math.abs(rate - r) < 0.005)) {
      out.push(issue('info', 'inconsistent', ['tax_total'], `Tax is ${(rate * 100).toFixed(1)}% of the taxable value, which is not a standard GST rate (0, 5, 12, 18 or 28%).`));
    }
  }
  const issued = date('invoice_date');
  const due = date('due_date');
  if (issued && due && due < issued) {
    out.push(issue('error', 'inconsistent', ['invoice_date', 'due_date'], `Due date (${due}) is before the invoice date (${issued}).`));
  }
  return out;
}

// ─── Marksheet ───────────────────────────────────────────────────────
function marksheetIssues(extraction, { num, label }) {
  const out = [];
  const total = num('total_marks_obtained');
  const max = num('total_max_marks');
  const percentage = num('percentage');

  const subjects = extraction.tables.find(t => findColumn(t, /obtain|secured|scored|marks/i, /max|full|out of|total marks|pass/i) >= 0);
  let failedSubjects = 0;
  let subjectCount = 0;
  if (subjects) {
    const obtCol = findColumn(subjects, /obtain|secured|scored|marks/i, /max|full|out of|total marks|pass/i);
    const maxCol = findColumn(subjects, /max|full|out of/i);
    let sumObt = 0;
    let sumMax = 0;
    let counted = 0;
    for (const row of subjects.rows) {
      if (isSummaryRow(row)) continue;
      const obt = parseNumber(row[obtCol]);
      if (obt == null) continue;
      const m = maxCol >= 0 ? parseNumber(row[maxCol]) : null;
      sumObt += obt;
      if (m != null) sumMax += m;
      counted++;
      subjectCount++;
      if (m != null && obt > m) {
        out.push(issue('error', 'inconsistent', [], `${row[0] || 'A subject'}: marks obtained (${fmtNum(obt)}) exceed the maximum (${fmtNum(m)}).`));
      }
      if (m != null && m > 0 && obt < m * PASS_SHARE) failedSubjects++;
    }
    if (counted && total != null && Math.abs(sumObt - total) > 0.5) {
      out.push(issue('error', 'inconsistent', ['total_marks_obtained'], `Subject marks add up to ${fmtNum(sumObt)}, but the total shown is ${fmtNum(total)}.`));
    }
    if (counted && max != null && sumMax && Math.abs(sumMax - max) > 0.5) {
      out.push(issue('warning', 'inconsistent', ['total_max_marks'], `Subject maximum marks add up to ${fmtNum(sumMax)}, but ${label('total_max_marks').toLowerCase()} is ${fmtNum(max)}.`));
    }
  }
  if (total != null && max != null && total > max) {
    out.push(issue('error', 'inconsistent', ['total_marks_obtained', 'total_max_marks'], `Total marks obtained (${fmtNum(total)}) exceed the maximum (${fmtNum(max)}).`));
  }
  if (total != null && max && percentage != null) {
    const expected = (total / max) * 100;
    if (Math.abs(expected - percentage) > 0.6) {
      out.push(issue('error', 'inconsistent', ['percentage', 'total_marks_obtained', 'total_max_marks'],
        `Percentage ${fmtNum(percentage)}% does not match ${fmtNum(total)} / ${fmtNum(max)} = ${expected.toFixed(2)}%.`));
    }
  }
  const result = String(extraction.fields.find(f => f.key === 'result')?.normalizedValue || '').toUpperCase();
  const share = total != null && max ? total / max : percentage != null ? percentage / 100 : null;
  if (result === 'PASS' && (failedSubjects > 0 || (share != null && share < PASS_SHARE))) {
    out.push(issue('warning', 'inconsistent', ['result'], `Result is PASS, but ${failedSubjects ? `${failedSubjects} subject(s) are` : 'the overall score is'} below the usual 33% pass mark.`));
  }
  if (result === 'FAIL' && subjectCount && failedSubjects === 0 && share != null && share >= PASS_SHARE) {
    out.push(issue('warning', 'inconsistent', ['result'], 'Result is FAIL, but every subject and the overall score are above the usual 33% pass mark.'));
  }
  return out;
}

// ─── Dates ───────────────────────────────────────────────────────────
function dateOrderIssues(extraction, { date }) {
  const out = [];
  const pairs = {
    certificate: [['issue_date', 'valid_until', 'error']],
    identity_document: [['issue_date', 'expiry_date', 'error'], ['date_of_birth', 'issue_date', 'warning']],
    institutional_record: [['date', 'deadline_date', 'warning'], ['date', 'effective_date', 'info']],
    application_form: [['date_of_birth', 'application_date', 'warning']],
    marksheet: [['date_of_birth', 'issue_date', 'warning']],
  }[extraction.docType] || [];
  for (const [a, b, severity] of pairs) {
    const da = date(a);
    const db = date(b);
    if (da && db && db < da) {
      const fa = extraction.fields.find(f => f.key === a);
      const fb = extraction.fields.find(f => f.key === b);
      out.push(issue(severity, 'inconsistent', [a, b], `${fb.label} (${db}) is before ${fa.label.toLowerCase()} (${da}).`));
    }
  }
  return out;
}

function futureDateIssues(extraction, now) {
  const out = [];
  const today = now.toISOString().slice(0, 10);
  const oldest = `${now.getUTCFullYear() - 120}-01-01`;
  for (const f of extraction.fields) {
    if (f.type !== 'date' || !f.normalizedValue) continue;
    if (f.key === 'date_of_birth') {
      if (f.normalizedValue > today) out.push(issue('error', 'inconsistent', [f.key], `${f.label} (${f.normalizedValue}) is in the future.`));
      else if (f.normalizedValue < oldest) out.push(issue('warning', 'inconsistent', [f.key], `${f.label} (${f.normalizedValue}) is implausibly old.`));
      continue;
    }
    if (FUTURE_OK.has(f.key) || f.extra) continue;
    // One day of slack for time zones.
    const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
    if (f.normalizedValue > tomorrow) out.push(issue('warning', 'inconsistent', [f.key], `${f.label} (${f.normalizedValue}) is in the future.`));
  }
  const expiry = extraction.fields.find(f => (f.key === 'expiry_date' || f.key === 'valid_until') && f.normalizedValue);
  if (expiry && expiry.normalizedValue < today) {
    out.push(issue('info', 'inconsistent', [expiry.key], `${expiry.label} (${expiry.normalizedValue}) has passed; the document has expired.`));
  }
  return out;
}

// ─── Names written differently, duplicated IDs ───────────────────────
function similarity(a, b) {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

// Titles are not part of the name: "Mr. Rohan Mehtaa" is compared as "rohan mehtaa".
const HONORIFIC_WORDS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'shri', 'sri', 'smt', 'kumari', 'km', 'श्री', 'श्रीमती', 'सुश्री', 'डॉ']);
const HONORIFICS = new RegExp(`^(${[...HONORIFIC_WORDS].join('|')})\\s+`);
function nameKey(value) {
  let s = looseText(value);
  for (let prev; prev !== s;) {
    prev = s;
    s = s.replace(HONORIFICS, '');
  }
  return s;
}

const NAME_FIELDS = /(^|_)(name|recipient|holder|applicant|student)(_|$)|seller_name|buyer_name|issuing_organization|institution/;

// Name fields of the main person, also checked against the page text.
const PERSON_NAME_FIELDS = /^(recipient_name|student_name|applicant_name|holder_name)$/;

function spellingIssues(extraction, textByPage = []) {
  const out = [];
  const seen = new Set();
  // Names from name-like fields and PERSON / ORG entities.
  const names = [
    ...extraction.fields.filter(f => f.value != null && f.type === 'string' && NAME_FIELDS.test(f.key)).map(f => ({ value: f.value, key: f.key, kind: /organization|institution|seller|buyer/.test(f.key) ? 'ORG' : 'PERSON' })),
    ...extraction.entities.filter(e => e.type === 'PERSON' || e.type === 'ORG').map(e => ({ value: e.value, key: null, kind: e.type })),
  ];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i];
      const b = names[j];
      if (a.kind !== b.kind) continue;
      const la = nameKey(a.value);
      const lb = nameKey(b.value);
      if (la.length < 5 || lb.length < 5 || la === lb) continue;
      // Same number of words and nearly the same letters: a variant spelling.
      // ("Example Traders" vs "Example Traders Pvt Ltd" differ in word count and are fine.)
      if (la.split(' ').length !== lb.split(' ').length || similarity(la, lb) < 0.8) continue;
      const pair = [la, lb].sort().join('|');
      if (seen.has(pair)) continue;
      seen.add(pair);
      out.push(issue('warning', 'inconsistent', [a.key, b.key].filter(Boolean),
        `The same ${a.kind === 'ORG' ? 'organisation' : 'name'} is written differently: "${a.value}" and "${b.value}".`));
    }
  }

  // The page text itself: a near-identical spelling of the person's name
  // elsewhere in the document (independent of which entities the model listed).
  for (const f of extraction.fields.filter(x => x.value != null && PERSON_NAME_FIELDS.test(x.key))) {
    const name = nameKey(f.value);
    const n = name.split(' ').length;
    if (name.length < 6 || n < 2 || n > 4) continue;
    for (const text of textByPage) {
      const words = String(text || '').match(/[\p{L}\p{N}\p{M}]+/gu) || [];
      const keys = words.map(w => looseText(w)).filter(w => !HONORIFIC_WORDS.has(w));
      for (let i = 0; i + n <= keys.length; i++) {
        const variant = keys.slice(i, i + n).join(' ');
        if (variant === name || similarity(variant, name) < 0.8) continue;
        const pair = [name, variant].sort().join('|');
        if (seen.has(pair)) continue;
        seen.add(pair);
        const shown = keys.slice(i, i + n).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        out.push(issue('warning', 'inconsistent', [f.key], `The same name is written differently: "${f.value}" and "${shown}".`));
      }
    }
  }
  return out;
}

function duplicateIdIssues(extraction) {
  const out = [];
  const ids = extraction.fields.filter(f => f.type === 'id' && f.value != null && !f.format);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = String(ids[i].normalizedValue ?? ids[i].value).replace(/\s/g, '').toUpperCase();
      const b = String(ids[j].normalizedValue ?? ids[j].value).replace(/\s/g, '').toUpperCase();
      if (a && a === b) {
        out.push(issue('warning', 'inconsistent', [ids[i].key, ids[j].key], `${ids[i].label} and ${ids[j].label} have the same number (${ids[i].value}).`));
      }
    }
  }
  // The PAN inside a GSTIN (characters 3-12) should match the PAN given.
  const gstin = extraction.fields.find(f => f.key === 'seller_gstin' && f.value != null)?.normalizedValue;
  const pan = extraction.fields.find(f => f.key === 'seller_pan' && f.value != null)?.normalizedValue;
  if (gstin && pan && FORMATS.gstin.test(gstin) && FORMATS.pan.test(pan) && gstin.slice(2, 12) !== pan) {
    out.push(issue('warning', 'inconsistent', ['seller_gstin', 'seller_pan'], `The PAN in the GSTIN (${gstin.slice(2, 12)}) differs from the PAN shown (${pan}).`));
  }
  return out;
}

// ─── Identity and tax numbers (checksums, PAN structure) ──────────────
const NAME_FOR_ID = { seller_pan: 'seller_name', seller_gstin: 'seller_name', buyer_gstin: 'buyer_name' };

function idNumberIssues(extraction) {
  const out = [];
  const byKey = new Map(extraction.fields.map(f => [f.key, f]));
  const valueOf = key => (byKey.get(key)?.value != null ? byKey.get(key).value : null);
  const panFieldValues = new Set(extraction.fields
    .filter(f => f.format === 'pan' && f.value != null)
    .map(f => String(f.normalizedValue ?? f.value).toUpperCase()));
  // An ID document that says it is a PAN card: its id_number is a PAN of the holder.
  const isPanCard = /\bpan\b|permanent account/i.test(valueOf('document_name') || '');

  // subject names the PAN in messages, e.g. "Seller PAN ABCDE1234F".
  const panProblems = (pan, panKey, subject, nameKey) => {
    const name = nameKey ? valueOf(nameKey) : null;
    for (const p of checkPan(pan, name).problems) {
      out.push(p.reason === 'name_initial'
        ? issue('warning', 'inconsistent', [panKey, nameKey].filter(Boolean), `${subject}: ${p.detail}.`)
        : issue('warning', 'format', [panKey], `${subject} is not a valid PAN: ${p.detail}.`));
    }
  };

  for (const f of extraction.fields) {
    if (f.value == null) continue;
    const label = `${f.key} ${f.label}`;
    if (f.format === 'aadhaar' || /aadhaar|aadhar/i.test(label)) {
      const a = checkAadhaar(f.value);
      if (a.kind === 'full') {
        out.push(issue('warning', 'format', [f.key], `${f.label} shows a full Aadhaar number; it should be masked (${maskAadhaar(f.value)}).`));
      } else if (a.kind === 'invalid' && /\d{4}/.test(String(f.value))) {
        out.push(issue('warning', 'format', [f.key], `${f.label} "${maskAadhaar(f.value)}" is not a valid Aadhaar number: ${a.detail}.`));
      }
    } else if (/\bvid\b|virtual id/i.test(label)) {
      const v = checkVid(f.value);
      if (!v.valid) out.push(issue('warning', 'format', [f.key], `${f.label} is not a valid Virtual ID: ${v.detail}.`));
    }

    const n = String(f.normalizedValue ?? f.value).toUpperCase().replace(/[\s-]/g, '');
    if (f.format === 'pan' && FORMATS.pan.test(n)) panProblems(n, f.key, `${f.label} ${n}`, NAME_FOR_ID[f.key]);
    if (f.key === 'id_number' && isPanCard && FORMATS.pan.test(n)) panProblems(n, f.key, `PAN ${n}`, 'holder_name');

    if (f.format === 'gstin' && FORMATS.gstin.test(n)) {
      if (!gstinChecksumValid(n)) {
        out.push(issue('warning', 'format', [f.key],
          `${f.label} "${f.value}" fails the GSTIN checksum (the last character should be "${gstinCheckChar(n.slice(0, 14))}"), so a character was probably misread.`));
      }
      // The PAN inside the GSTIN (characters 3-12), unless the same PAN is a field of its own.
      const embedded = n.slice(2, 12);
      if (!panFieldValues.has(embedded)) panProblems(embedded, f.key, `The PAN inside ${f.label} (${embedded})`, NAME_FOR_ID[f.key]);
    }
  }
  return out;
}

/**
 * All rule-based issues of an extraction (everything except low confidence,
 * which needs the confidence scores). `now` is injectable for tests.
 */
export function validateExtraction(extraction, { now = new Date(), textByPage = [] } = {}) {
  const ctx = fieldMap(extraction);
  const issues = [
    ...missingIssues(extraction),
    ...formatIssues(extraction),
    ...(extraction.docType === 'invoice' ? invoiceIssues(extraction, ctx) : []),
    ...(extraction.docType === 'marksheet' ? marksheetIssues(extraction, ctx) : []),
    ...dateOrderIssues(extraction, ctx),
    ...futureDateIssues(extraction, now),
    ...spellingIssues(extraction, textByPage),
    ...duplicateIdIssues(extraction),
    ...idNumberIssues(extraction),
  ];
  if (extraction.docTypeConfidence != null && extraction.docTypeConfidence < LOW_CONFIDENCE) {
    issues.push(issue('info', 'low_confidence', [], `The document type is uncertain (${Math.round(extraction.docTypeConfidence * 100)}% confidence).`));
  }
  return dedupe(issues);
}

/** Issues for required fields whose (scored) confidence is below 0.5. */
export function lowConfidenceIssues(fields) {
  return fields
    .filter(f => f.required && f.value != null && f.confidence < LOW_CONFIDENCE)
    .map(f => issue('warning', 'low_confidence', [f.key], `${f.label} "${f.value}" has low confidence (${Math.round(f.confidence * 100)}%); please check it against the document.`));
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
function dedupe(issues) {
  const seen = new Set();
  return issues
    .filter(i => (seen.has(i.message) ? false : seen.add(i.message)))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function sortIssues(issues) {
  return dedupe(issues);
}
