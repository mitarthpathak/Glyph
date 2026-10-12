import { overallConfidence, scoreExtraction } from './confidence.js';
import { lowConfidenceIssues, sortIssues, validateExtraction } from './validate.js';
import { calibrateClassification } from './classify.js';

/**
 * Post-processing after the model (or rule-based) extraction:
 *  0. classification calibrated from model, keywords and required fields (classify.js);
 *  1. rule-based validation (missing, format, cross-field consistency);
 *  2. confidence scoring against the document text, using those issues;
 *  3. low-confidence issues for required fields under 0.5;
 *  4. overall document confidence.
 * ctx: { textByPage, textLayerPages, ocrUsed, now? }.
 */
export function finalizeExtraction(rawExtraction, { now, ...ctx }) {
  const extraction = calibrateClassification(rawExtraction, { textByPage: ctx.textByPage });
  const ruleIssues = validateExtraction(extraction, { now, textByPage: ctx.textByPage });
  const scored = scoreExtraction(extraction, { ...ctx, issues: ruleIssues });
  const issues = sortIssues([...ruleIssues, ...lowConfidenceIssues(scored.fields)]);
  return { ...scored, issues, overallConfidence: overallConfidence(scored.fields, issues) };
}
