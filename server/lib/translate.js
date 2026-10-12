/**
 * Translation of a stored document between Hindi and English.
 *
 * The AI translates the title, the summary, the free-text field values and
 * the page text (names, numbers, IDs, dates and amounts stay as written).
 * When the AI is not available, Hindi is transliterated to Latin letters
 * instead (translit.js), so a reader of English can still read names and
 * places: { method: 'transliteration' }.
 *
 * Result: { language, method: 'ai' | 'transliteration', model?, title,
 *           summary, fields: [{ key, label, original, value }],
 *           pages: [{ page, text }], basedOn, createdAt }.
 */
import { generateStructured, isAiConfigured } from './ai.js';
import { hasDevanagari, transliterate } from './translit.js';

export const LANGUAGES = { en: 'English', hi: 'Hindi' };
const MAX_PAGES = 5;
const MAX_PAGE_CHARS = 6000;
const AI_BUDGET_MS = 45_000;
// Field types whose values are words, not numbers, codes or dates.
const TEXT_TYPES = new Set(['string', 'list', 'enum']);

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    fields: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] } },
    pages: { type: 'array', items: { type: 'object', properties: { page: { type: 'integer' }, text: { type: 'string' } }, required: ['page', 'text'] } },
  },
  required: ['title', 'summary', 'fields', 'pages'],
};

const needsTranslation = (text, to) => (to === 'en' ? hasDevanagari(text) : /[A-Za-z]{3}/.test(text));

/** What there is to translate in one direction. */
function sourceOf(extraction, to) {
  const fields = (extraction.fields || [])
    .filter(f => f.value != null && TEXT_TYPES.has(f.type) && needsTranslation(String(f.value), to))
    .map(f => ({ key: f.key, label: f.label, value: String(f.value) }));
  const pages = (extraction.rawTextByPage || []).slice(0, MAX_PAGES)
    .map((t, i) => ({ page: i + 1, text: String(t || '').slice(0, MAX_PAGE_CHARS) }))
    .filter(p => p.text.trim() && needsTranslation(p.text, to));
  return { title: extraction.title || '', summary: extraction.summary || '', fields, pages };
}

function prompt(source, to) {
  return [
    `TRANSLATION TASK: translate this document content into ${LANGUAGES[to]}.`,
    'Rules: translate faithfully and completely; keep names of people and organisations, numbers, IDs, codes, dates and amounts exactly as written',
    `(write names in ${to === 'en' ? 'Latin letters' : 'Devanagari'} only if they are in the other script); keep line breaks in page text;`,
    'text that is already in the target language stays unchanged. Answer with JSON: title, summary, fields [{ key, value }] for the given keys, pages [{ page, text }].',
    '',
    'SOURCE (JSON):',
    JSON.stringify(source),
  ].join('\n');
}

function parseAnswer(text, source) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw.title !== 'string' || typeof raw.summary !== 'string') {
    throw Object.assign(new Error('not a translation'), { code: 'BAD_AI_OUTPUT' });
  }
  const byKey = new Map((Array.isArray(raw.fields) ? raw.fields : []).filter(f => f && typeof f.value === 'string').map(f => [f.key, f.value.trim()]));
  const byPage = new Map((Array.isArray(raw.pages) ? raw.pages : []).filter(p => p && typeof p.text === 'string').map(p => [Number(p.page), p.text]));
  return {
    title: raw.title.trim().slice(0, 300) || source.title,
    summary: raw.summary.trim().slice(0, 3000) || source.summary,
    fields: source.fields.map(f => ({ key: f.key, label: f.label, original: f.value, value: (byKey.get(f.key) || f.value).slice(0, 1000) })),
    pages: source.pages.map(p => ({ page: p.page, text: (byPage.get(p.page) || '').slice(0, MAX_PAGE_CHARS * 2) })).filter(p => p.text.trim()),
  };
}

/** Hindi → Latin letters, without the AI. */
function transliterated(source) {
  return {
    title: transliterate(source.title),
    summary: transliterate(source.summary),
    fields: source.fields.map(f => ({ key: f.key, label: f.label, original: f.value, value: transliterate(f.value, { capitalize: /name/.test(f.key) }) })),
    pages: source.pages.map(p => ({ page: p.page, text: transliterate(p.text) })),
  };
}

/**
 * Translate a stored document (`to`: 'en' | 'hi'). Throws { status } when
 * the language is unknown or a translation to Hindi needs the AI.
 */
export async function translateDocument(doc, { to = 'en', now = new Date() } = {}) {
  if (!LANGUAGES[to]) throw Object.assign(new Error(`Language must be one of: ${Object.keys(LANGUAGES).join(', ')}.`), { status: 400 });
  const source = sourceOf(doc.extraction || {}, to);
  const base = { language: to, basedOn: (doc.audit || []).length, createdAt: now.toISOString() };
  if (isAiConfigured()) {
    try {
      const result = await generateStructured({
        parts: [{ text: prompt(source, to) }], schema: SCHEMA, deadline: Date.now() + AI_BUDGET_MS, tag: 'Translate',
        parse: text => parseAnswer(text, source),
      });
      const { model, ...rest } = result;
      return { ...base, method: 'ai', model, ...rest };
    } catch (err) {
      console.error('[Translate] AI translation failed:', err.code || err.status || '', err.message);
    }
  }
  if (to !== 'en') {
    throw Object.assign(new Error('Translation to Hindi needs the AI service, which is not available right now. Please try again later.'), { status: 503 });
  }
  return { ...base, method: 'transliteration', ...transliterated(source) };
}
