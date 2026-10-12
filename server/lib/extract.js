import { generateStructured, parseJson } from './ai.js';
import { DOCUMENT_TYPES, DOC_TYPE_IDS, ENTITY_TYPES, getDocType } from './schemas.js';
import { asciiDigits, cleanValue, normalizeValue, parseAmount, parseDate } from './normalize.js';

/**
 * Bump when the prompt, schema or normalisation changes so cached
 * extractions of the same file are recomputed.
 */
export const EXTRACTION_VERSION = 3;

const MAX_QUOTE = 120;
const MAX_FIELDS = 60;
const MAX_ENTITIES = 60;
const MAX_TABLES = 10;
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLS = 20;
// OCR transcription returned for scanned inputs (used for search), kept short for latency.
const OCR_PAGES = 5;
const OCR_CHARS_PER_PAGE = 2000;

const nullable = type => ({ type: [type, 'null'] });

/** JSON schema of the model's answer (Gemini structured output). */
export const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    docType: { type: 'string', enum: DOC_TYPE_IDS },
    docTypeConfidence: { type: 'number' },
    title: { type: 'string' },
    language: { type: 'string' },
    summary: { type: 'string' },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          label: { type: 'string' },
          value: nullable('string'),
          normalizedValue: nullable('string'),
          confidence: { type: 'number' },
          page: nullable('integer'),
          sourceQuote: nullable('string'),
        },
        required: ['key', 'label', 'value', 'confidence'],
      },
    },
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ENTITY_TYPES },
          value: { type: 'string' },
          page: nullable('integer'),
          sourceQuote: nullable('string'),
        },
        required: ['type', 'value'],
      },
    },
    tables: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          page: nullable('integer'),
          columns: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        },
        required: ['columns', 'rows'],
      },
    },
    ocrText: {
      type: 'array',
      items: {
        type: 'object',
        properties: { page: { type: 'integer' }, text: { type: 'string' } },
        required: ['page', 'text'],
      },
    },
  },
  required: ['docType', 'docTypeConfidence', 'title', 'language', 'summary', 'fields', 'entities'],
};

function typeCatalog() {
  return DOCUMENT_TYPES.map(t => {
    const fields = t.fields
      .map(fl => `${fl.key} (${fl.format || fl.type}${fl.required ? ', required' : ''}${fl.options ? `: ${fl.options.join('|')}` : ''}) - ${fl.description}`)
      .join('\n    ');
    return `- ${t.id}: ${t.label}. ${t.description}\n    ${fields}`;
  }).join('\n');
}

const INSTRUCTIONS = `You are a document-intelligence engine for Indian institutional documents: forms, certificates, invoices, marksheets, reports, ID cards, letters and notices. Read the document and return ONE JSON object matching the schema.

1. CLASSIFY: docType is one of the types below; docTypeConfidence is 0-1. Use "other" only if nothing fits.
2. FIELDS: return one entry for EVERY predefined field of the chosen type (same key, in order). Then add up to 15 more important key-value pairs found in the document as extra fields with short snake_case keys.
   - value: exactly as written in the document (trimmed). If the field is not in the document, value = null, confidence = 0, sourceQuote = null, page = null. NEVER guess or invent a value.
   - normalizedValue: dates as YYYY-MM-DD (numeric Indian dates are DD/MM/YYYY - never swap day and month), amounts as plain numbers without currency or commas (₹1,18,000.00 -> 118000.00), phone numbers as digits with country code, IDs in upper case without spaces. Otherwise null.
   - confidence: 0-1, how sure you are that the value is correct AND belongs to this field. Lower it for blurry, handwritten, partly hidden or ambiguous values.
   - page: 1-based page number where the value appears (text inputs mark pages with "=== PAGE n ===").
   - sourceQuote: a VERBATIM snippet (max ${MAX_QUOTE} characters) copied character-for-character from the document that contains the value, e.g. the label and value together. Keep Hindi/Devanagari text as written. Do not paraphrase or translate quotes.
3. ENTITIES: up to 40 important named entities: PERSON, ORG, DATE, AMOUNT, ID, LOCATION, EMAIL, PHONE, OTHER, each with page and a verbatim sourceQuote.
4. TABLES: tabular data such as invoice line items or subject-wise marks: columns and rows as written (max ${MAX_TABLE_ROWS} rows). Empty array if none.
5. SUMMARY: 2-4 concise, factual sentences: what the document is, who issued it to whom, the key dates, amounts or results, and anything clearly missing or inconsistent. title: a short display title (max 8 words).
6. language: ISO code(s) of the document text, e.g. "en", "hi", "hi+en".

Handle any layout: multi-column pages, tables, label-above-value and label-left-of-value forms, rotated or skewed scans, noisy photos, stamps and seals, and legible handwriting. Bilingual Hindi + English documents: use the English label for keys, keep values as written. Mention stamps, seals and signatures when they are visible or referred to. Aadhaar numbers must be reported masked (XXXX XXXX 1234) - never output a full Aadhaar number.

DOCUMENT TYPES AND THEIR PREDEFINED FIELDS:
${typeCatalog()}`;

const OCR_INSTRUCTION = `\n\nThis input is a scanned page or photo: also return ocrText, a plain transcription of each of the first ${OCR_PAGES} pages (max ${OCR_CHARS_PER_PAGE} characters per page, reading order).`;

// ─── Normalisation of the model's answer ─────────────────────────────
const clamp01 = v => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  // Some answers use 0-100 instead of 0-1.
  const x = n > 1 && n <= 100 ? n / 100 : n;
  return Math.round(Math.min(1, Math.max(0, x)) * 100) / 100;
};
const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const toKey = v => str(String(v ?? ''), 60).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function cleanPage(v, pageCount) {
  const n = Math.round(Number(asciiDigits(v)));
  if (!Number.isFinite(n) || n < 1) return null;
  return pageCount ? Math.min(n, pageCount) : n;
}

function cleanQuote(v) {
  const q = cleanValue(v, 1000);
  if (!q) return null;
  return q.length > MAX_QUOTE ? q.slice(0, MAX_QUOTE - 1).trimEnd() + '…' : q;
}

function buildField(def, raw, pageCount) {
  const value = cleanValue(raw?.value);
  const modelNorm = cleanValue(raw?.normalizedValue);
  const modelConfidence = value == null ? 0 : raw?.confidence == null ? 0.5 : clamp01(raw.confidence);
  return {
    key: def.key,
    label: def.label || str(raw?.label, 80) || def.key,
    type: def.type,
    ...(def.format ? { format: def.format } : {}),
    required: Boolean(def.required),
    ...(def.extra ? { extra: true } : {}),
    value,
    normalizedValue: normalizeValue(def, value, modelNorm),
    modelConfidence,
    // Replaced by the blended score in confidence.js.
    confidence: modelConfidence,
    page: value == null ? null : cleanPage(raw?.page, pageCount),
    sourceQuote: value == null ? null : cleanQuote(raw?.sourceQuote),
  };
}

/** Guess a field type for an extra (non-predefined) field from its value. */
function guessType(key, value) {
  if (value == null) return 'string';
  if (/date|dob|dated|valid|expiry/.test(key) && parseDate(value)) return 'date';
  if (/@/.test(value) && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value)) return 'email';
  if (/(amount|total|price|rate|fee|tax|cost|balance)/.test(key) && parseAmount(value) != null) return 'amount';
  if (/(phone|mobile|contact)/.test(key)) return 'phone';
  if (/(_no|number|_id|code)$/.test(key)) return 'id';
  return 'string';
}

function cleanTables(rawTables, pageCount) {
  return (Array.isArray(rawTables) ? rawTables : [])
    .slice(0, MAX_TABLES)
    .map(t => {
      const columns = (Array.isArray(t?.columns) ? t.columns : []).slice(0, MAX_TABLE_COLS).map(c => str(String(c ?? ''), 80));
      const width = columns.length;
      const rows = (Array.isArray(t?.rows) ? t.rows : [])
        .filter(Array.isArray)
        .slice(0, MAX_TABLE_ROWS)
        .map(r => {
          const cells = r.slice(0, Math.max(width, 1)).map(c => str(String(c ?? ''), 200));
          while (width && cells.length < width) cells.push('');
          return cells;
        })
        .filter(r => r.some(Boolean));
      return { title: str(t?.title, 100) || 'Table', page: cleanPage(t?.page, pageCount), columns, rows };
    })
    .filter(t => t.columns.length && t.rows.length);
}

function fallbackSummary(type, fields) {
  const known = fields.filter(f => f.value != null && !f.extra).slice(0, 3).map(f => `${f.label.toLowerCase()} ${f.value}`);
  return `${type.label}${known.length ? ` with ${known.join(', ')}` : ''}.`;
}

/**
 * Turn the model's answer into a clean extraction: a known docType, every
 * predefined field of that type (null when absent), bounded extras,
 * de-duplicated entities, rectangular tables and a non-empty summary.
 * Throws (code BAD_AI_OUTPUT) when the answer is not an extraction at all.
 */
export function normalizeExtraction(raw, { pageCount = 1 } = {}) {
  if (!raw || typeof raw !== 'object' || (!Array.isArray(raw.fields) && !raw.docType && !raw.summary)) {
    throw Object.assign(new Error('AI answer is not a document extraction'), { code: 'BAD_AI_OUTPUT' });
  }
  const docType = DOC_TYPE_IDS.includes(raw.docType) ? raw.docType : 'other';
  const type = getDocType(docType);

  const rawFields = (Array.isArray(raw.fields) ? raw.fields : []).filter(x => x && typeof x === 'object');
  const byKey = new Map();
  for (const rf of rawFields) {
    const key = toKey(rf.key || rf.label);
    if (!key) continue;
    // Prefer the entry that actually has a value.
    if (!byKey.has(key) || (cleanValue(byKey.get(key).value) == null && cleanValue(rf.value) != null)) byKey.set(key, rf);
  }

  const fields = type.fields.map(def => buildField(def, byKey.get(def.key), pageCount));
  const predefined = new Set(type.fields.map(d => d.key));
  for (const [key, rf] of byKey) {
    if (predefined.has(key) || fields.length >= MAX_FIELDS) continue;
    const value = cleanValue(rf.value);
    if (value == null) continue; // extras are only useful when present
    const def = { key, label: str(rf.label, 80) || key.replace(/_/g, ' '), type: guessType(key, value), required: false, extra: true };
    fields.push(buildField(def, rf, pageCount));
  }

  const seen = new Set();
  const entities = [];
  for (const e of Array.isArray(raw.entities) ? raw.entities : []) {
    const value = cleanValue(e?.value, 200);
    if (!value) continue;
    const etype = ENTITY_TYPES.includes(String(e.type).toUpperCase()) ? String(e.type).toUpperCase() : 'OTHER';
    const k = `${etype}|${value.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    entities.push({ type: etype, value, page: cleanPage(e.page, pageCount), sourceQuote: cleanQuote(e.sourceQuote) });
    if (entities.length >= MAX_ENTITIES) break;
  }

  const ocrText = (Array.isArray(raw.ocrText) ? raw.ocrText : [])
    .map(p => ({ page: cleanPage(p?.page, pageCount), text: typeof p?.text === 'string' ? p.text.trim().slice(0, OCR_CHARS_PER_PAGE) : '' }))
    .filter(p => p.page && p.text);

  const summary = str(raw.summary, 1200) || fallbackSummary(type, fields);
  return {
    docType,
    docTypeLabel: type.label,
    docTypeConfidence: clamp01(raw.docTypeConfidence),
    title: str(raw.title, 100) || type.label,
    language: str(raw.language, 20) || 'en',
    summary,
    fields,
    entities,
    tables: cleanTables(raw.tables, pageCount),
    ocrText,
  };
}

/**
 * Classify, extract and summarise a document in ONE structured Gemini call.
 * `input` comes from prepareDocumentInput(): { mode, text?, file?, pageCount }.
 */
export async function extractDocument(input, { deadline }) {
  const ocr = input.mode !== 'text';
  const parts = [{ text: INSTRUCTIONS + (ocr ? OCR_INSTRUCTION : '') }];
  if (input.file && input.mode !== 'text') {
    parts.push({ inlineData: { mimeType: input.file.mimeType, data: input.file.data.toString('base64') } });
  }
  if (input.text && input.mode !== 'file') {
    const note = input.mode === 'text+file'
      ? `Pages ${(input.lowTextPages || []).join(', ')} have no text layer: read them from the attached file.\n\n`
      : '';
    parts.push({ text: `${note}DOCUMENT TEXT (${input.pageCount} page${input.pageCount === 1 ? '' : 's'}):\n${input.text}` });
  }
  return generateStructured({
    parts,
    schema: EXTRACTION_SCHEMA,
    temperature: 0,
    deadline,
    tag: 'Extract',
    parse: text => normalizeExtraction(parseJson(text), { pageCount: input.pageCount }),
  });
}

// ─── Rule-based fallback (AI unavailable, digital PDFs only) ─────────
const ENTITY_PATTERNS = [
  ['EMAIL', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g],
  ['PHONE', /(?:\+91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g],
  ['ID', /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g], // GSTIN
  ['ID', /\b[A-Z]{5}\d{4}[A-Z]\b/g], // PAN
  ['AMOUNT', /(?:₹|Rs\.?|INR)\s?\d[\d,]*(?:\.\d{1,2})?/gi],
  ['DATE', /\b\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})\b|\b\d{1,2}(?:st|nd|rd|th)? (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{4}\b/g],
  ['LOCATION', /\b[1-9]\d{5}\b(?=[^\d]|$)/g], // PIN code
];

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function guessDocType(text) {
  const lower = text.toLowerCase();
  let best = { id: 'other', score: 0 };
  for (const t of DOCUMENT_TYPES) {
    const score = t.keywords.reduce((n, k) => n + (lower.includes(k.toLowerCase()) ? (k.includes(' ') ? 2 : 1) : 0), 0);
    if (score > best.score) best = { id: t.id, score };
  }
  return { docType: best.id, docTypeConfidence: best.score ? Math.min(0.6, 0.25 + best.score * 0.07) : 0.2 };
}

/** "Label: value" lookup for one field on the page lines. */
function findLabelled(def, lines) {
  const labels = [def.label, def.key.replace(/_/g, ' '), ...(def.aliases || [])].map(l => l.toLowerCase());
  for (const label of labels) {
    const re = new RegExp(`(?:^|\\b)${escapeRe(label)}\\s*(?:#|no\\.?)?\\s*[:\\-–]\\s*(.+)$`, 'i');
    for (const { text, page } of lines) {
      const m = text.match(re);
      if (m && cleanValue(m[1])) return { value: m[1].trim(), page, sourceQuote: text };
    }
  }
  return null;
}

/**
 * Basic extraction without the AI, for digital PDFs: keyword-based type
 * guess, "Label: value" matching and regex entities. Confidences are low by
 * design; the result is marked as a fallback and never cached.
 */
export function fallbackExtract(pages) {
  const lines = pages.flatMap((p, i) => String(p || '').split('\n').map(text => ({ text: text.trim(), page: i + 1 }))).filter(l => l.text);
  const fullText = lines.map(l => l.text).join('\n');
  const { docType, docTypeConfidence } = guessDocType(fullText);
  const type = getDocType(docType);

  const rawFields = type.fields.map(def => {
    const hit = findLabelled(def, lines);
    return hit ? { key: def.key, label: def.label, value: hit.value, confidence: 0.4, page: hit.page, sourceQuote: hit.sourceQuote } : { key: def.key, value: null };
  });

  const entities = [];
  for (const [etype, re] of ENTITY_PATTERNS) {
    for (const { text, page } of lines) {
      for (const m of text.matchAll(re)) entities.push({ type: etype, value: m[0].trim(), page, sourceQuote: text });
    }
  }

  const firstLines = lines.slice(0, 3).map(l => l.text).join(' ').slice(0, 200);
  const extraction = normalizeExtraction({
    docType,
    docTypeConfidence,
    title: lines[0]?.text.slice(0, 80) || type.label,
    language: /[ऀ-ॿ]/.test(fullText) ? (/[a-z]/i.test(fullText) ? 'hi+en' : 'hi') : 'en',
    summary: `Basic rule-based extraction (AI unavailable). Looks like a ${type.label.toLowerCase()}${firstLines ? ` beginning "${firstLines}"` : ''}.`,
    fields: rawFields,
    entities,
    tables: [],
  }, { pageCount: pages.length || 1 });
  return { ...extraction, model: 'rule-based' };
}
