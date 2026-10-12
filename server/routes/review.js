import express from 'express';
import { getDocument, updateDocument } from '../lib/db.js';
import { ownerLabel, requireOwner } from '../lib/owner.js';
import { reviewDocument, reviewField } from '../lib/review.js';
import { toDocumentResponse } from '../lib/documentView.js';

const router = express.Router();
const notFound = res => res.status(404).json({ success: false, error: 'Document not found.' });

/** Run a review action on a stored document and save it with its audit entry. */
async function apply(req, res, act) {
  const doc = await getDocument(req.params.id, req.owner);
  if (!doc) return notFound(res);
  let result;
  try {
    result = act(doc.extraction, { by: ownerLabel(req.owner), now: new Date() });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, error: err.message });
    throw err;
  }
  const saved = await updateDocument(req.params.id, req.owner, { extraction: result.extraction },
    { audit: result.audit, auditLength: (doc.audit || []).length });
  if (!saved) {
    return res.status(409).json({ success: false, error: 'The document was changed in the meantime. Reload it and try again.' });
  }
  res.json(toDocumentResponse(saved, { auditEntry: result.audit }));
}

/**
 * PATCH /api/documents/:id/fields/:key  { action: confirm | correct | reset, value?, note? }
 * Confirm, correct or reset one field; the document is validated again.
 */
router.patch('/documents/:id/fields/:key', requireOwner, (req, res) =>
  apply(req, res, (x, ctx) => reviewField(x, req.params.key, req.body || {}, ctx)));

/** POST /api/documents/:id/review  { action: approve | reopen, note? } */
router.post('/documents/:id/review', requireOwner, (req, res) =>
  apply(req, res, (x, ctx) => reviewDocument(x, req.body || {}, ctx)));

/** GET /api/documents/:id/audit: the full review trail, oldest first. */
router.get('/documents/:id/audit', requireOwner, async (req, res) => {
  const doc = await getDocument(req.params.id, req.owner);
  if (!doc) return notFound(res);
  res.json({ success: true, audit: doc.audit || [] });
});

export default router;
