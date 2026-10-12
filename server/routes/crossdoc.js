import express from 'express';
import { listDocuments } from '../lib/db.js';
import { requireOwner } from '../lib/owner.js';
import { CROSS_RULES, crossDocumentIssues } from '../lib/crossdoc.js';

const router = express.Router();
// Cross-document checks compare an owner's documents with each other.
const MAX_DOCS = 300;

/**
 * GET /api/crosscheck?documentId=
 * Conflicts between the owner's documents (same person or organisation
 * described differently); with documentId, only those involving it.
 */
router.get('/crosscheck', requireOwner, async (req, res) => {
  const documentId = req.query.documentId ? String(req.query.documentId) : null;
  const docs = await listDocuments(req.owner, MAX_DOCS);
  if (documentId && !docs.some(d => String(d._id) === documentId)) {
    return res.status(404).json({ success: false, error: 'Document not found.' });
  }
  const issues = crossDocumentIssues(docs, { documentId });
  res.json({ success: true, documentCount: docs.length, count: issues.length, issues, rules: CROSS_RULES });
});

export default router;
