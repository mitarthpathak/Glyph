import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// The library entry (not the package index, which runs a debug self-test).
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

// A page with fewer characters than this has no usable text layer.
export const SCANNED_CHARS_PER_PAGE = 40;
// A PDF counts as "mixed" (some pages scanned) when at least this share of its pages has no text layer.
const MIXED_PAGE_SHARE = 0.25;
const MAX_PAGES = 200;
// Text sent to the model; Gemini Flash's context is far larger, this keeps latency and cost down.
export const MAX_PROMPT_TEXT_CHARS = 120_000;
// Mixed PDFs also get the file attached (for OCR of the scanned pages) up to this size.
const MAX_INLINE_FILE_BYTES = 4 * 1024 * 1024;

const cleanPageText = text =>
  String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * pdf.js page text: a line break where the baseline changes, and a space
 * between items on the same line that are visibly apart (table cells,
 * columns) so values do not run together.
 */
async function renderPage(pageData) {
  const content = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
  let lastY;
  let lastEnd;
  let text = '';
  for (const item of content.items) {
    const [, , , , x, y] = item.transform;
    if (lastY === undefined) {
      text += item.str;
    } else if (Math.abs(y - lastY) > 1) {
      text += '\n' + item.str;
    } else {
      const gap = x - lastEnd;
      text += (gap > 1.5 && !text.endsWith(' ') && !item.str.startsWith(' ') ? ' ' : '') + item.str;
    }
    lastY = y;
    lastEnd = x + (item.width || 0);
  }
  return text;
}

/**
 * Extract text page by page. Returns
 * { pages: string[], pageCount, avgCharsPerPage, lowTextPages: number[], textLayer }
 * where textLayer is 'digital', 'mixed' or 'scanned'. Never throws: an
 * unreadable PDF is reported as scanned so the OCR path can still try it.
 */
export async function readPdf(buffer) {
  const pages = [];
  let pageCount = 0;
  try {
    // Copy: small Buffers are views on Node's shared pool, and pdf.js would
    // read the whole pool instead of just this file.
    const parsed = await pdfParse(new Uint8Array(buffer), {
      max: MAX_PAGES,
      pagerender: async pageData => {
        const text = cleanPageText(await renderPage(pageData));
        // Pages are rendered in order; pageIndex is 0-based when available.
        const index = Number.isInteger(pageData.pageIndex) ? pageData.pageIndex : pages.length;
        pages[index] = text;
        return text;
      },
    });
    pageCount = parsed.numpages || pages.length;
  } catch (err) {
    console.error('[PDF] text extraction failed:', err.message);
  }
  for (let i = 0; i < pages.length; i++) pages[i] = pages[i] || '';
  pageCount = Math.max(pageCount, pages.length);
  return { pages, pageCount, ...classifyTextLayer(pages, pageCount) };
}

/** Decide whether a PDF has a usable text layer from its per-page text. */
export function classifyTextLayer(pages, pageCount = pages.length) {
  const counted = Math.max(1, Math.min(pageCount || 0, MAX_PAGES) || pages.length);
  const lengths = Array.from({ length: counted }, (_, i) => (pages[i] || '').replace(/\s/g, '').length);
  const total = lengths.reduce((a, b) => a + b, 0);
  const avgCharsPerPage = Math.round(total / counted);
  const lowTextPages = lengths.map((n, i) => (n < SCANNED_CHARS_PER_PAGE ? i + 1 : 0)).filter(Boolean);
  const textLayer =
    avgCharsPerPage < SCANNED_CHARS_PER_PAGE ? 'scanned'
    : lowTextPages.length / counted >= MIXED_PAGE_SHARE ? 'mixed'
    : 'digital';
  return { avgCharsPerPage, lowTextPages, textLayer };
}

/** Text with explicit page markers so the model can cite page numbers. */
export function pageTaggedText(pages, maxChars = MAX_PROMPT_TEXT_CHARS) {
  let out = '';
  for (let i = 0; i < pages.length; i++) {
    const block = `=== PAGE ${i + 1} ===\n${pages[i] || '(no text layer on this page)'}\n\n`;
    if (out.length + block.length > maxChars) {
      out += block.slice(0, Math.max(0, maxChars - out.length)) + `\n[... truncated after page ${i + 1} of ${pages.length} ...]`;
      break;
    }
    out += block;
  }
  return out.trim();
}

/**
 * Choose what to send to the model for one validated upload:
 *  - images and scanned PDFs: the file itself (Gemini does OCR + understanding in one call);
 *  - digital PDFs: page-tagged text only (cheapest, and verifiable quotes);
 *  - mixed PDFs: page-tagged text plus the file, so scanned pages are read too.
 * Returns { mode: 'text'|'file'|'text+file', ocrUsed, pageCount, pages, textLayer, text?, file? }.
 */
export async function prepareDocumentInput({ buffer, kind, mimeType }) {
  if (kind === 'image') {
    return { mode: 'file', ocrUsed: true, pageCount: 1, pages: [], textLayer: 'none', file: { data: buffer, mimeType } };
  }
  const pdf = await readPdf(buffer);
  const base = { pageCount: pdf.pageCount || 1, pages: pdf.pages, textLayer: pdf.textLayer, avgCharsPerPage: pdf.avgCharsPerPage };
  const file = { data: buffer, mimeType: 'application/pdf' };
  if (pdf.textLayer === 'scanned') return { ...base, mode: 'file', ocrUsed: true, file };
  const text = pageTaggedText(pdf.pages);
  if (pdf.textLayer === 'mixed' && buffer.length <= MAX_INLINE_FILE_BYTES) {
    return { ...base, mode: 'text+file', ocrUsed: true, text, file, lowTextPages: pdf.lowTextPages };
  }
  return { ...base, mode: 'text', ocrUsed: false, text };
}
