import mongoose from 'mongoose';

const GraphSchema = new mongoose.Schema({
  filename: { type: String, required: true },
  contentHash: { type: String, index: true },
  graph: { type: Object, default: null }, // { nodes, edges }; null for extraction-only documents
  metadata: { type: Object },
  source: { type: String, enum: ['ai', 'fallback'], default: 'ai' },
  model: { type: String },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, default: null },
  userEmail: { type: String, index: true }, // legacy records only
  // Document intelligence (see server/lib/extract.js)
  fileHash: { type: String, index: true },
  extractionVersion: { type: Number },
  mimeType: { type: String },
  fileSize: { type: Number },
  extraction: { type: Object, default: null },
  graphFallback: { type: Boolean }, // concept map built later from a document fell back to keywords
  createdAt: { type: Date, default: Date.now }
});

// Full-text index for document search. 'none' disables English stemming and
// stop words so Hindi and English tokens are matched alike.
GraphSchema.index(
  {
    filename: 'text',
    'extraction.title': 'text',
    'extraction.summary': 'text',
    'extraction.fields.value': 'text',
    'extraction.entities.value': 'text',
    'extraction.rawTextByPage': 'text',
  },
  {
    name: 'document_search',
    default_language: 'none',
    language_override: 'textSearchLanguage', // documents have a "language" field of their own
    weights: { 'extraction.fields.value': 6, 'extraction.title': 5, filename: 4, 'extraction.entities.value': 4, 'extraction.summary': 3, 'extraction.rawTextByPage': 1 },
  },
);

export default mongoose.models.Graph || mongoose.model('Graph', GraphSchema);
