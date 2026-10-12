/**
 * One uploaded file → a saved document extraction. Shared by POST /api/extract
 * (synchronous, ≤ 4 MB) and the async job queue (jobs.js).
 *
 * validate (magic bytes) → cache lookup → text layer / OCR plan → one Gemini
 * call (or the rule-based fallback) → validation + confidence → save.
 */
import crypto from 'crypto';
import { EXTRACTION_VERSION, extractDocument, fallbackExtract } from './extract.js';
import { detectFileType } from './files.js';
import { SCANNED_CHARS_PER_PAGE, prepareDocumentInput } from './pdfText.js';
import { findExtractionByHash, findUserExtractionByHash, saveGraph } from './db.js';
import { finalizeExtraction } from './pipeline.js';
import { textLayerPagesFor } from './confidence.js';
import { toDocumentResponse } from './documentView.js';
import { ownerFields } from './owner.js';
import { withoutReview } from './review.js';

// Page text kept for search and quote verification.
const MAX_PAGE_CHARS = 20_000;
const MAX_STORED_TEXT_CHARS = 200_000;

function trimPages(pages) {
  let budget = MAX_STORED_TEXT_CHARS;
  return pages.map(p => {
    const text = String(p || '').slice(0, Math.min(MAX_PAGE_CHARS, Math.max(0, budget)));
    budget -= text.length;
    return text;
  });
}

export const failResult = (filename, status, error) => ({ success: false, filename, status, error });

/** Fields copied when a cached extraction is saved for another owner (without its review or audit trail). */
function pickStored(d) {
  const { filename, fileHash, extractionVersion, mimeType, fileSize, source, model, metadata, extraction, file, quality } = d;
  return { filename, fileHash, extractionVersion, mimeType, fileSize, source, model, metadata, extraction: withoutReview(extraction), file, quality, graph: null };
}

/**
 * Process one file. `file`: { buffer, originalname, mimetype, size }.
 * Options: owner (user record, { guestId } or null), deadline (ms timestamp
 * for the AI call), fileRef (where the original is stored: a reference, or an
 * async function that stores it on demand and returns the reference),
 * quality (image quality report from the browser), onStage(stage).
 * Resolves to a document response or failResult(); never throws for bad input.
 */
export async function processDocument(file, { owner = null, deadline, fileRef = null, quality = null, onStage = () => {} } = {}) {
  const filename = file.originalname || 'document';
  let fileType;
  try {
    fileType = detectFileType(file.buffer, file);
  } catch (err) {
    return failResult(filename, err.status || 400, err.message);
  }

  const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const storedRef = async () => {
    if (typeof fileRef !== 'function') return fileRef;
    return fileRef(fileType).catch(err => {
      console.error('[Extract] could not store the original file:', err.message);
      return null;
    });
  };
  const cached = await findExtractionByHash(fileHash, EXTRACTION_VERSION).catch(() => null);
  if (cached) {
    console.log('[Extract] cache hit', fileHash.slice(0, 12));
    let doc = cached;
    const sameOwner = owner && (owner._id ? String(cached.userId ?? '') === String(owner._id) : cached.guestId === owner.guestId && !cached.userId);
    if (!sameOwner && (owner || cached.userId || cached.guestId)) {
      // Give this owner their own copy so it shows up in their documents.
      doc = (await findUserExtractionByHash(fileHash, EXTRACTION_VERSION, owner).catch(() => null)) ||
        (await (async () => {
          const ref = (await storedRef()) || cached.file || null;
          return saveGraph({ ...pickStored(cached), filename, ...ownerFields(owner), file: ref, ...(quality ? { quality } : {}) });
        })().catch(() => cached));
    }
    return toDocumentResponse(doc, { cached: true, filename });
  }

  onStage('reading');
  const input = await prepareDocumentInput({ buffer: file.buffer, kind: fileType.kind, mimeType: fileType.mimeType });
  let result;
  let source = 'ai';
  let warning;
  onStage('extracting');
  try {
    result = await extractDocument(input, { deadline });
  } catch (err) {
    console.error('[Extract] AI extraction failed:', err.code || err.status || '', err.message);
    const what = fileType.kind === 'image' ? 'This image needs OCR' : 'This PDF has no selectable text';
    if (input.mode !== 'text') {
      return failResult(filename, 422, err.code === 'NO_API_KEY'
        ? `${what} and the AI service is not configured.`
        : `${what} and the AI service is busy right now. Please try again in a minute.`);
    }
    result = fallbackExtract(input.pages);
    source = 'fallback';
    warning = err.code === 'NO_API_KEY'
      ? 'AI is not configured on the server, so a basic rule-based extraction was done.'
      : 'The AI service is busy right now, so a basic rule-based extraction was done. Upload again later for a full AI extraction.';
  }

  onStage('validating');
  const { model, ocrText, ...rawExtraction } = result;
  // Text used for search and source-quote checks: the PDF text layer, or the
  // model's transcription for scans and photos.
  const ocrPage = n => (ocrText || []).find(p => p.page === n)?.text || '';
  const textByPage = Array.from({ length: input.pageCount }, (_, i) => {
    const layer = input.pages[i] || '';
    const usable = layer.replace(/\s/g, '').length >= SCANNED_CHARS_PER_PAGE && !(input.unreliablePages || []).includes(i + 1);
    return usable ? layer : ocrPage(i + 1) || layer;
  });
  const extraction = finalizeExtraction(rawExtraction, {
    textByPage,
    ocrUsed: input.ocrUsed,
    textLayerPages: textLayerPagesFor(input.pages, input.pageCount, input.ocrUsed, input.unreliablePages),
    quality,
  });
  const doc = {
    filename,
    fileHash,
    extractionVersion: EXTRACTION_VERSION,
    mimeType: fileType.mimeType,
    fileSize: file.size ?? file.buffer.length,
    source,
    model,
    ...ownerFields(owner),
    graph: null,
    metadata: { title: extraction.title, description: extraction.summary, category: extraction.docTypeLabel },
    ...(quality ? { quality } : {}),
    extraction: {
      ...extraction,
      ocrUsed: input.ocrUsed,
      textLayer: input.textLayer,
      pageCount: input.pageCount,
      rawTextByPage: trimPages(textByPage),
    },
  };
  onStage('saving');
  const ref = await storedRef();
  if (ref) doc.file = ref;
  let saved;
  try {
    saved = await saveGraph(doc);
  } catch (err) {
    // Still return the result even if persistence fails.
    console.error('[Extract] could not save document:', err.message);
    saved = { ...doc, _id: crypto.randomUUID(), createdAt: new Date() };
  }
  return toDocumentResponse(saved, warning ? { warning } : {});
}
