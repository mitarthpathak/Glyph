import express from 'express';
import { analyzeDocument, buildFallbackGraph } from '../lib/ai.js';
import { deleteGraph, getDocument, listDocuments, updateDocument } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { toCsv, toDocumentResponse, toDocumentSummary, toJsonExport } from '../lib/documentView.js';
import { rateLimit } from '../lib/rateLimit.js';

const router = express.Router();
const AI_BUDGET_MS = 50_000;
const mapLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 15, message: 'Upload limit reached. Please try again in a few minutes.' });

const notFound = res => res.status(404).json({ success: false, error: 'Document not found.' });
const safeName = s => String(s || 'document').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'document';

// Saved document extractions of the signed-in user.
router.get('/documents', requireAuth, async (req, res) => {
  const docs = await listDocuments(req.user);
  res.json({ success: true, documents: docs.map(toDocumentSummary) });
});

router.get('/documents/:id', requireAuth, async (req, res) => {
  const doc = await getDocument(req.params.id, req.user);
  if (!doc) return notFound(res);
  res.json(toDocumentResponse(doc));
});

router.delete('/documents/:id', requireAuth, async (req, res) => {
  const doc = await getDocument(req.params.id, req.user);
  if (!doc || !(await deleteGraph(req.params.id, req.user))) return notFound(res);
  res.json({ success: true });
});

router.get('/documents/:id/export', requireAuth, async (req, res) => {
  const doc = await getDocument(req.params.id, req.user);
  if (!doc) return notFound(res);
  const format = String(req.query.format || 'json').toLowerCase();
  const name = safeName(doc.filename);
  if (format === 'csv') {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${name}-extraction.csv"`);
    return res.send(toCsv(doc));
  }
  if (format !== 'json') return res.status(400).json({ success: false, error: 'Format must be json or csv.' });
  res.set('Content-Disposition', `attachment; filename="${name}-extraction.json"`);
  res.json(toJsonExport(doc));
});

/**
 * Build the concept map / roadmap / quiz from an extracted document, so one
 * upload serves both features. The map is stored on the same record (and
 * then appears in History); a second call returns the stored map.
 */
router.post('/documents/:id/concept-map', requireAuth, mapLimiter, async (req, res) => {
  const startedAt = Date.now();
  const doc = await getDocument(req.params.id, req.user);
  if (!doc) return notFound(res);
  const respond = (d, extra = {}) => res.json({
    success: true, id: String(d._id), filename: d.filename, graph: d.graph, metadata: d.metadata,
    createdAt: d.createdAt, fallbackUsed: Boolean(d.graphFallback), ...extra,
  });
  if (doc.graph?.nodes?.length) return respond(doc, { cached: true });

  const text = (doc.extraction?.rawTextByPage || []).join('\n\n').trim();
  if (!text) {
    return res.status(422).json({ success: false, error: 'No readable text was found in this document, so a concept map cannot be built.' });
  }
  let result;
  let warning;
  let graphFallback = false;
  try {
    result = await analyzeDocument({ text }, { deadline: startedAt + AI_BUDGET_MS });
  } catch (err) {
    console.error('[ConceptMap] AI analysis failed:', err.code || err.status || '', err.message);
    result = buildFallbackGraph(text);
    graphFallback = true;
    warning = err.code === 'NO_API_KEY'
      ? 'AI is not configured on the server, so a basic keyword map was generated.'
      : 'The AI service is busy right now, so a basic keyword map was generated.';
  }
  const updated = await updateDocument(doc._id, req.user, { graph: result.graph, metadata: result.metadata, graphFallback });
  respond(updated || { ...doc, graph: result.graph, metadata: result.metadata, graphFallback }, warning ? { warning } : {});
});

export default router;
