import { overallConfidence, scoreExtraction } from './confidence.js';

/**
 * Post-processing after the model (or rule-based) extraction:
 * confidence scoring against the document text, then the overall
 * document confidence.
 * ctx: { textByPage, textLayerPages, ocrUsed }.
 */
export function finalizeExtraction(extraction, ctx) {
  const issues = [];
  const scored = scoreExtraction(extraction, { ...ctx, issues });
  return { ...scored, issues, overallConfidence: overallConfidence(scored.fields, issues) };
}
