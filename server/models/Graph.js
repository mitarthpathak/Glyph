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
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.models.Graph || mongoose.model('Graph', GraphSchema);
