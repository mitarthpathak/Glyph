import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { EXTRACTION_VERSION, extractDocument, fallbackExtract } from '../lib/extract.js';
import { MAX_UPLOAD_BYTES, detectFileType, precheckUpload } from '../lib/files.js';
import { SCANNED_CHARS_PER_PAGE, prepareDocumentInput } from '../lib/pdfText.js';
import { findExtractionByHash, findUserExtractionByHash, saveGraph } from '../lib/db.js';
import { rateLimit } from '../lib/rateLimit.js';
import { finalizeExtraction } from '../lib/pipeline.js';
import { textLayerPagesFor } from '../lib/confidence.js';
import { toDocumentResponse } from '../lib/documentView.js';

// The whole request must finish inside Vercel's 60 s function limit.
const AI_BUDGET_MS = 50_000;
// Files in one request are processed in parallel; the 4 MB body limit applies to all of them together.
export const MAX_FILES_PER_REQUEST = 5;
// Page text kept for search and quote verification.
const MAX_PAGE_CHARS = 20_000;
const MAX_STORED_TEXT_CHARS = 200_000;

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_FILES_PER_REQUEST },
  fileFilter: (_req, file, cb) => {
    try {
      precheckUpload(file);
      cb(null, true);
    } catch (err) {
      cb(err, false);
    }
  },
});
const extractLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 40, message: 'Upload limit reached. Please try again in a few minutes.' });

function trimPages(pages) {
  let budget = MAX_STORED_TEXT_CHARS;
  return pages.map(p => {
    const text = String(p || '').slice(0, Math.min(MAX_PAGE_CHARS, Math.max(0, budget)));
    budget -= text.length;
    return text;
  });
}

const fail = (filename, status, error) => ({ success: false, filename, status, error });

/** Validate, extract (or reuse a cached extraction) and save one file. */
async function processFile(file, { userId, deadline }) {
  const filename = file.originalname || 'document';
  let fileType;
  try {
    fileType = detectFileType(file.buffer, file);
  } catch (err) {
    return fail(filename, err.status || 400, err.message);
  }

  const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const cached = await findExtractionByHash(fileHash, EXTRACTION_VERSION).catch(() => null);
  if (cached) {
    console.log('[Extract] cache hit', fileHash.slice(0, 12));
    let doc = cached;
    if (String(cached.userId ?? '') !== String(userId ?? '')) {
      // Give this user their own copy so it shows up in their documents.
      doc = (await findUserExtractionByHash(fileHash, EXTRACTION_VERSION, userId).catch(() => null)) ||
        (await saveGraph({ ...pickStored(cached), filename, userId }).catch(() => cached));
    }
    return toDocumentResponse(doc, { cached: true, filename });
  }

  const input = await prepareDocumentInput({ buffer: file.buffer, kind: fileType.kind, mimeType: fileType.mimeType });
  let result;
  let source = 'ai';
  let warning;
  try {
    result = await extractDocument(input, { deadline });
  } catch (err) {
    console.error('[Extract] AI extraction failed:', err.code || err.status || '', err.message);
    const what = fileType.kind === 'image' ? 'This image needs OCR' : 'This PDF has no selectable text';
    if (input.mode !== 'text') {
      return fail(filename, 422, err.code === 'NO_API_KEY'
        ? `${what} and the AI service is not configured.`
        : `${what} and the AI service is busy right now. Please try again in a minute.`);
    }
    result = fallbackExtract(input.pages);
    source = 'fallback';
    warning = err.code === 'NO_API_KEY'
      ? 'AI is not configured on the server, so a basic rule-based extraction was done.'
      : 'The AI service is busy right now, so a basic rule-based extraction was done. Upload again later for a full AI extraction.';
  }

  const { model, ocrText, ...rawExtraction } = result;
  // Text used for search and source-quote checks: the PDF text layer, or the
  // model's transcription for scans and photos.
  const ocrPage = n => (ocrText || []).find(p => p.page === n)?.text || '';
  const textByPage = Array.from({ length: input.pageCount }, (_, i) => {
    const layer = input.pages[i] || '';
    return layer.replace(/\s/g, '').length >= SCANNED_CHARS_PER_PAGE ? layer : ocrPage(i + 1) || layer;
  });
  const extraction = finalizeExtraction(rawExtraction, {
    textByPage,
    ocrUsed: input.ocrUsed,
    textLayerPages: textLayerPagesFor(input.pages, input.pageCount, input.ocrUsed),
  });
  const doc = {
    filename,
    fileHash,
    extractionVersion: EXTRACTION_VERSION,
    mimeType: fileType.mimeType,
    fileSize: file.size ?? file.buffer.length,
    source,
    model,
    userId,
    graph: null,
    metadata: { title: extraction.title, description: extraction.summary, category: extraction.docTypeLabel },
    extraction: {
      ...extraction,
      ocrUsed: input.ocrUsed,
      textLayer: input.textLayer,
      pageCount: input.pageCount,
      rawTextByPage: trimPages(textByPage),
    },
  };
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

/** Fields copied when a cached extraction is saved for another user. */
function pickStored(d) {
  const { filename, fileHash, extractionVersion, mimeType, fileSize, source, model, metadata, extraction } = d;
  return { filename, fileHash, extractionVersion, mimeType, fileSize, source, model, metadata, extraction, graph: null };
}

/**
 * POST /api/extract  (multipart, field "files", up to 5 files; "file" also accepted)
 * Every file is processed independently and saved as its own document.
 * Responds { success, documents: [...] }; a file that fails has
 * { success: false, filename, error } in the list. When every file fails the
 * response status is that of the first failure.
 */
router.post('/extract', extractLimiter,
  upload.fields([{ name: 'files', maxCount: MAX_FILES_PER_REQUEST }, { name: 'file', maxCount: 1 }]),
  async (req, res) => {
    const startedAt = Date.now();
    const files = [...(req.files?.files || []), ...(req.files?.file || [])].slice(0, MAX_FILES_PER_REQUEST);
    if (!files.length) return res.status(400).json({ success: false, error: 'Please choose a PDF or image file to upload.' });

    const userId = req.user?._id ?? null;
    const deadline = startedAt + AI_BUDGET_MS;
    const documents = await Promise.all(files.map(file =>
      processFile(file, { userId, deadline }).catch(err => {
        console.error('[Extract] unexpected error:', err);
        return fail(file.originalname || 'document', 500, 'Something went wrong while reading this file. Please try again.');
      })));

    for (const d of documents) {
      console.log(`[Extract] ${d.filename}: ${d.success ? `${d.docType}${d.cached ? ' (cached)' : ''}${d.fallbackUsed ? ' (fallback)' : ''}` : `failed (${d.status})`}`);
    }
    const okCount = documents.filter(d => d.success).length;
    if (!okCount) {
      const first = documents[0];
      return res.status(first.status || 422).json({ success: false, error: first.error, documents });
    }
    res.json({ success: true, documents, elapsedMs: Date.now() - startedAt });
  });

export default router;
