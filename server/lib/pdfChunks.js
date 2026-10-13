import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { processDocument } from './processDocument.js';
import { saveGraph, findExtractionByHash } from './db.js';
import { EXTRACTION_VERSION } from './extract.js';
import { finalizeExtraction } from './pipeline.js';
import { toDocumentResponse } from './documentView.js';

export const PDF_CHUNK_PAGES = 5;

/** Merge citations in original page coordinates, retaining conflicting field values. */
export function mergeChunk(previous, result, offset) {
  const shift = entry => ({ ...entry, page: entry.page ? entry.page + offset : null });
  const raw = result.rawExtraction;
  const merged = previous ? structuredClone(previous) : {
    ...raw, fields: [], entities: [], tables: [], textByPage: [], textLayerPages: [], ocrUsed: false,
  };
  if (previous && raw.summary && !merged.summary.includes(raw.summary)) merged.summary = `${merged.summary} ${raw.summary}`.slice(0, 4000);
  for (const field of raw.fields || []) {
    const value = shift(field);
    const existing = merged.fields.find(f => f.key === value.key);
    if (!existing) merged.fields.push(value);
    else if (existing.value == null && value.value != null) Object.assign(existing, value);
    else if (value.value != null && existing.value !== value.value) {
      merged.fields.push({ ...value, key: `${value.key}_page_${value.page || offset + 1}`, extra: true });
    }
  }
  for (const entity of raw.entities || []) {
    const value = shift(entity);
    if (!merged.entities.some(e => e.type === value.type && e.value === value.value && e.page === value.page)) merged.entities.push(value);
  }
  merged.tables.push(...(raw.tables || []).map(shift));
  merged.textByPage.push(...result.doc.extraction.rawTextByPage);
  merged.textLayerPages.push(...result.textLayerPages);
  merged.ocrUsed ||= result.doc.extraction.ocrUsed;
  return merged;
}

/** Process only one bounded page range, then persist a continuation for the next request. */
export async function processPdfChunk(file, options) {
  const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  if (!options.checkpoint && await findExtractionByHash(fileHash, EXTRACTION_VERSION)) return processDocument(file, options);
  await options.onStage?.('reading');
  const pdf = await PDFDocument.load(file.buffer);
  const pageCount = pdf.getPageCount();
  const offset = options.checkpoint?.nextPage || 0;
  const end = Math.min(offset + PDF_CHUNK_PAGES, pageCount);
  await options.onPageProgress?.({ pageCount, pagesCompleted: offset, pageStart: offset + 1, pageEnd: end,
    chunkIndex: Math.floor(offset / PDF_CHUNK_PAGES) + 1, chunkCount: Math.ceil(pageCount / PDF_CHUNK_PAGES) });
  if (pageCount <= PDF_CHUNK_PAGES) return processDocument(file, options);
  // Bound checkpoint size below MongoDB's document limit, without silently truncating pages.
  if (pageCount > 500) return { success: false, error: 'Please split PDFs longer than 500 pages before uploading.' };
  const checkpoint = options.checkpoint;
  if (checkpoint && checkpoint.fileHash !== fileHash) return { success: false, error: 'The uploaded file changed during processing. Please upload it again.' };
  const part = await PDFDocument.create();
  for (const page of await part.copyPages(pdf, Array.from({ length: end - offset }, (_, i) => offset + i))) part.addPage(page);
  const buffer = Buffer.from(await part.save({ useObjectStreams: false }));
  if (Date.now() > options.deadline - 5000) throw new Error('PDF preparation exceeded the processing budget');
  const result = await processDocument({ ...file, buffer, size: buffer.length }, { ...options, fileRef: null, deferSave: true });
  if (!result.success) return result;
  const merged = mergeChunk(checkpoint?.merged, result, offset);
  if (Buffer.byteLength(JSON.stringify(merged)) > 800_000) return { success: false, error: 'This PDF contains too much extracted data. Please split it into smaller files.' };
  const fallback = checkpoint?.fallback || result.doc.source === 'fallback';
  const warning = checkpoint?.warning || result.warning;
  if (end < pageCount) {
    await options.saveCheckpoint({ nextPage: end, pageCount, fileHash, merged, fallback, warning });
    return { pending: true };
  }
  const { textByPage, textLayerPages, ocrUsed, ...raw } = merged;
  await options.onStage?.('validating');
  const extraction = finalizeExtraction(raw, { textByPage, textLayerPages, ocrUsed, quality: options.quality });
  const doc = {
    ...result.doc, fileHash, fileSize: file.buffer.length, file: options.fileRef,
    source: fallback ? 'fallback' : 'ai',
    metadata: { title: extraction.title, description: extraction.summary, category: extraction.docTypeLabel },
    extraction: { ...extraction, pageCount, ocrUsed, textLayer: ocrUsed ? 'mixed' : 'digital', rawTextByPage: textByPage },
  };
  await options.onStage?.('saving');
  const saved = await saveGraph(doc);
  return toDocumentResponse(saved, warning ? { warning } : {});
}
