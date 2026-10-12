import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';
import { confidenceBand, percent } from '../lib/api';
import { PagePreview } from './PagePreview';
import type { DocumentIssue, DocumentResult, ExtractedEntity, ExtractedField, SourceFocus } from '../types';

// Existing palette: tertiary = good, amber = attention, red = problem.
export const BAND_STYLES = {
  high: 'bg-tertiary/10 text-tertiary border-tertiary/20',
  medium: 'bg-amber-50 text-amber-600 border-amber-100',
  low: 'bg-red-50 text-red-500 border-red-100',
} as const;

const SEVERITY = {
  error: { icon: 'error', text: 'text-red-500', box: 'bg-red-50 border-red-100' },
  warning: { icon: 'warning', text: 'text-amber-600', box: 'bg-amber-50 border-amber-100' },
  info: { icon: 'info', text: 'text-primary', box: 'bg-primary/5 border-primary/20' },
} as const;

const ISSUE_GROUPS: { type: DocumentIssue['type']; label: string }[] = [
  { type: 'missing', label: 'Missing' },
  { type: 'inconsistent', label: 'Inconsistent' },
  { type: 'format', label: 'Format' },
  { type: 'low_confidence', label: 'Low confidence' },
];

const ENTITY_ICONS: Record<string, string> = {
  PERSON: 'person', ORG: 'apartment', DATE: 'event', AMOUNT: 'payments', ID: 'badge',
  LOCATION: 'location_on', EMAIL: 'mail', PHONE: 'call', OTHER: 'label',
};

export function ConfidenceChip({ value, band, className }: { value: number | null | undefined; band?: string; className?: string }) {
  const b = (band as keyof typeof BAND_STYLES) || confidenceBand(value);
  return (
    <span
      className={cn('px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border whitespace-nowrap', BAND_STYLES[b], className)}
      title={`${b} confidence`}
    >
      {percent(value)} · {b}
    </span>
  );
}

const display = (f: ExtractedField) => (f.value == null ? null : Array.isArray(f.normalizedValue) ? f.normalizedValue.join('; ') : f.value);

/** The quote with the field's value highlighted (when it occurs verbatim). */
function QuoteWithValue({ quote, value }: { quote: string; value: string | null }) {
  const i = value ? quote.toLowerCase().indexOf(value.toLowerCase()) : -1;
  if (!value || i < 0) return <>{quote}</>;
  return (
    <>
      {quote.slice(0, i)}
      <mark className="bg-primary/10 text-primary rounded px-0.5">{quote.slice(i, i + value.length)}</mark>
      {quote.slice(i + value.length)}
    </>
  );
}

interface DocumentScreenProps {
  doc: DocumentResult | null;
  recentDocs: DocumentResult[];
  selectedFieldKey: string | null;
  onSelectField: (key: string | null) => void;
  onSelectDoc: (doc: DocumentResult) => void;
  onUploadClick: () => void;
  onExport: (format: 'json' | 'csv') => Promise<void>;
  onBuildConceptMap: () => Promise<void>;
  onAsk: () => void;
  /** A cited passage to show when no field is selected. */
  focus?: SourceFocus | null;
  onClearFocus?: () => void;
}

export function DocumentScreen({ doc, recentDocs, selectedFieldKey, onSelectField, onSelectDoc, onUploadClick, onExport, onBuildConceptMap, onAsk, focus = null, onClearFocus = () => {} }: DocumentScreenProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showEmpty, setShowEmpty] = useState(false);
  const sourceRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => doc?.fields.find(f => f.key === selectedFieldKey) || null, [doc, selectedFieldKey]);

  // Bring the source panel into view when a field is opened (e.g. from search):
  // on phones the page scrolls to it; on desktop the side column scrolls to its top.
  useEffect(() => {
    if (!(selected || focus)) return;
    if (window.innerWidth < 1024) sourceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else sideRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [selected, focus]);

  useEffect(() => {
    setActionError(null);
  }, [doc?.id]);

  if (!doc) {
    return (
      <div className="py-8 space-y-8">
        <div>
          <p className="text-[10px] font-bold text-primary uppercase tracking-widest">Document Intelligence</p>
          <h2 className="text-4xl md:text-5xl font-headline font-bold">Extracted Information</h2>
        </div>
        <div className="text-center py-24 bg-surface-container-low rounded-[40px] border border-slate-200">
          <span className="material-symbols-outlined text-6xl text-slate-300 mb-4 block">plagiarism</span>
          <p className="text-slate-500 font-medium mb-5">No document yet. Upload a PDF, scan or photo to extract its information.</p>
          <button onClick={onUploadClick} className="px-5 py-2.5 bg-primary text-white text-sm font-bold rounded-xl hover:opacity-90">
            Upload a Document
          </button>
        </div>
      </div>
    );
  }

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setActionError(null);
    try {
      await fn();
    } catch (err: any) {
      setActionError(err?.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const found = doc.fields.filter(f => f.value != null);
  const missingFields = doc.fields.filter(f => f.value == null);
  const visibleFields = showEmpty ? doc.fields : found.concat(missingFields.filter(f => f.required));
  const issueKeys = new Map<string, DocumentIssue['severity']>();
  for (const i of doc.issues) for (const k of i.fieldKeys) if (!issueKeys.has(k) || i.severity === 'error') issueKeys.set(k, i.severity);
  const entityGroups = doc.entities.reduce<Record<string, ExtractedEntity[]>>((acc, e) => {
    (acc[e.type] ||= []).push(e);
    return acc;
  }, {});
  const counts = { error: 0, warning: 0, info: 0, ...(doc.issueCounts || {}) };
  if (!doc.issueCounts) for (const i of doc.issues) counts[i.severity]++;

  return (
    <div className="space-y-8 py-8" data-testid="document-screen">
      {/* ─── Header ─────────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row md:justify-between md:items-end gap-4 w-full">
        <div className="min-w-0">
          <p className="text-[10px] font-bold text-primary uppercase tracking-widest">Document Intelligence</p>
          <h2 className="text-4xl md:text-5xl font-headline font-bold break-words">{doc.title || doc.filename}</h2>
          <div className="flex flex-wrap gap-2 mt-4" aria-label="Document properties">
            <span className="px-4 py-1 bg-primary/10 text-primary text-[10px] font-black uppercase rounded-full border border-primary/20 tracking-widest" data-testid="doc-type-badge">
              {doc.docTypeLabel} · {percent(doc.docTypeConfidence)}
            </span>
            {doc.ocrUsed && (
              <span className="px-4 py-1 bg-secondary/10 text-secondary text-[10px] font-black uppercase rounded-full border border-secondary/20 tracking-widest" data-testid="ocr-badge" title="Text was read from the image with OCR">
                OCR
              </span>
            )}
            <span className="px-4 py-1 bg-slate-100 text-slate-500 text-[10px] font-black uppercase rounded-full border border-slate-200 tracking-widest">
              {doc.pageCount} {doc.pageCount === 1 ? 'Page' : 'Pages'}
            </span>
            {doc.language && (
              <span className="px-4 py-1 bg-slate-100 text-slate-500 text-[10px] font-black uppercase rounded-full border border-slate-200 tracking-widest">
                {doc.language}
              </span>
            )}
            {doc.fallbackUsed && (
              <span className="px-4 py-1 bg-amber-50 text-amber-600 text-[10px] font-black uppercase rounded-full border border-amber-100 tracking-widest">
                Basic extraction
              </span>
            )}
          </div>
        </div>
        <div className="bg-surface-container-high px-8 py-4 rounded-[32px] border border-slate-200 shadow-sm text-center self-start md:self-auto shrink-0">
          <p className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Confidence</p>
          <p className={cn('text-3xl font-headline font-bold', confidenceBand(doc.overallConfidence) === 'high' ? 'text-tertiary' : confidenceBand(doc.overallConfidence) === 'medium' ? 'text-amber-600' : 'text-red-500')} data-testid="overall-confidence">
            {percent(doc.overallConfidence)}
          </p>
        </div>
      </div>

      {doc.fallbackUsed && (
        <div className="px-5 py-3 bg-amber-50 border border-amber-100 rounded-2xl text-sm text-amber-700">
          This is a basic rule-based extraction because the AI service was unavailable. Upload the document again later for a full AI extraction.
        </div>
      )}

      {/* ─── Actions and documents from this session ───────── */}
      <div className="flex flex-wrap items-center gap-2">
        {recentDocs.length > 1 && recentDocs.map(d => (
          <button
            key={d.id}
            onClick={() => onSelectDoc(d)}
            aria-pressed={d.id === doc.id}
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 rounded-full text-[10px] font-bold uppercase transition-colors max-w-[220px]',
              d.id === doc.id ? 'bg-primary text-white' : 'bg-primary/10 text-primary hover:bg-primary/20'
            )}
          >
            <span className="material-symbols-outlined text-sm">description</span>
            <span className="truncate">{d.filename}</span>
          </button>
        ))}
        <div className="flex flex-wrap gap-2 md:ml-auto">
          <button
            onClick={onAsk}
            className="flex items-center gap-2 px-3 py-1.5 bg-primary/10 rounded-full text-[10px] text-primary font-bold uppercase hover:bg-primary/20 transition-colors"
            data-testid="ask-document"
          >
            <span className="material-symbols-outlined text-sm">forum</span>
            Ask this document
          </button>
          <button
            onClick={() => run('json', () => onExport('json'))}
            disabled={!!busy}
            className="flex items-center gap-2 px-3 py-1.5 bg-tertiary/10 rounded-full text-[10px] text-tertiary font-bold uppercase hover:bg-tertiary/20 transition-colors disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-sm">data_object</span>
            {busy === 'json' ? 'Exporting…' : 'Export JSON'}
          </button>
          <button
            onClick={() => run('csv', () => onExport('csv'))}
            disabled={!!busy}
            className="flex items-center gap-2 px-3 py-1.5 bg-tertiary/10 rounded-full text-[10px] text-tertiary font-bold uppercase hover:bg-tertiary/20 transition-colors disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-sm">table_view</span>
            {busy === 'csv' ? 'Exporting…' : 'Export CSV'}
          </button>
          <button
            onClick={() => run('map', onBuildConceptMap)}
            disabled={!!busy}
            className="flex items-center gap-2 px-3 py-1.5 bg-secondary/10 rounded-full text-[10px] text-secondary font-bold uppercase hover:bg-secondary/20 transition-colors disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-sm">account_tree</span>
            {busy === 'map' ? 'Building map…' : doc.hasGraph ? 'Open Concept Map' : 'Build Concept Map'}
          </button>
        </div>
      </div>
      {actionError && (
        <p role="alert" className="text-red-500 text-sm font-medium px-4 py-2 bg-red-50 rounded-lg border border-red-100">{actionError}</p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* ─── Left: summary, fields, tables, entities ──────── */}
        <div className="lg:col-span-7 space-y-8 min-w-0">
          <div className="bg-surface-container-low p-8 rounded-[32px] border border-slate-200 shadow-sm">
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant mb-4 opacity-50">Summary</p>
            <p className="text-on-surface leading-relaxed font-medium" data-testid="doc-summary">{doc.summary}</p>
            <p className="text-[10px] font-bold text-primary uppercase tracking-[0.2em] mt-4 truncate">{doc.filename}</p>
          </div>

          <div className="bg-surface-container-low p-6 md:p-8 rounded-[32px] border border-slate-200 shadow-sm">
            <div className="flex justify-between items-center mb-6 gap-4">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant opacity-50">Extracted Fields</p>
                <p className="text-xl font-headline font-bold mt-1">{found.length} of {doc.fields.length} found</p>
              </div>
              {missingFields.some(f => !f.required) && (
                <button
                  onClick={() => setShowEmpty(v => !v)}
                  aria-pressed={showEmpty}
                  className="text-[10px] font-bold text-primary uppercase tracking-widest hover:underline shrink-0"
                >
                  {showEmpty ? 'Hide empty' : 'Show all fields'}
                </button>
              )}
            </div>
            <p className="text-[10px] text-on-surface-variant mb-3">Select a field to see where it was found.</p>
            <ul className="space-y-2" aria-label="Extracted fields" data-testid="fields-table">
              {visibleFields.map(f => {
                const value = display(f);
                const isSelected = f.key === selectedFieldKey;
                const flagged = issueKeys.get(f.key);
                return (
                  <li key={f.key}>
                    <button
                      onClick={() => onSelectField(isSelected ? null : f.key)}
                      aria-pressed={isSelected}
                      aria-label={`${f.label}: ${value ?? 'missing'}, ${percent(f.confidence)} confidence${f.page ? `, page ${f.page}` : ''}`}
                      className={cn(
                        'w-full text-left grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-3 px-4 py-3 rounded-2xl border transition-all',
                        isSelected ? 'bg-surface-container-high border-primary/30' : 'bg-white border-slate-200 hover:border-primary/30'
                      )}
                      data-testid="field-row"
                    >
                      {/* Label above the value on phones, side by side from sm up. */}
                      <span className="min-w-0 flex flex-col gap-1 sm:contents">
                      <span className="min-w-0">
                        <span className="block text-[10px] font-bold uppercase tracking-wider text-on-surface-variant sm:truncate">
                          {f.label}{f.required && <span className="text-primary"> *</span>}
                        </span>
                        {flagged && (
                          <span className={cn('flex items-center gap-1 text-[9px] font-bold uppercase', SEVERITY[flagged].text)}>
                            <span className="material-symbols-outlined text-[12px]">{SEVERITY[flagged].icon}</span>
                            Check
                          </span>
                        )}
                      </span>
                      <span className={cn('text-sm break-words min-w-0', value == null ? 'text-slate-400 italic' : 'font-medium text-on-surface')}>
                        {value ?? (f.required ? 'Missing' : 'Not found')}
                      </span>
                      </span>
                      <span className="flex flex-col items-end gap-1">
                        <ConfidenceChip value={f.confidence} band={f.confidenceBand} />
                        {f.page && <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">p.{f.page}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {doc.tables.map((t, ti) => (
            <div key={ti} className="bg-surface-container-low p-6 md:p-8 rounded-[32px] border border-slate-200 shadow-sm">
              <div className="flex justify-between items-center mb-4">
                <p className="text-xl font-headline font-bold">{t.title}</p>
                {t.page && <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">p.{t.page}</span>}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      {t.columns.map((c, ci) => (
                        <th key={ci} className="text-left text-[10px] font-bold uppercase tracking-wider text-on-surface-variant px-3 py-2 border-b border-slate-200">{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {t.rows.map((r, ri) => (
                      <tr key={ri} className="border-b border-slate-100 last:border-0">
                        {r.map((cell, ci) => <td key={ci} className="px-3 py-2 text-on-surface">{cell}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {doc.entities.length > 0 && (
            <div className="bg-surface-container-low p-6 md:p-8 rounded-[32px] border border-slate-200 shadow-sm space-y-5">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant opacity-50">Entities</p>
              {Object.entries(entityGroups).map(([type, list]) => (
                <div key={type}>
                  <p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-primary mb-2">
                    <span className="material-symbols-outlined text-sm">{ENTITY_ICONS[type] || 'label'}</span>
                    {type}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {list.map((e, i) => (
                      <span
                        key={i}
                        title={e.sourceQuote ? `“${e.sourceQuote}”${e.page ? ` (page ${e.page})` : ''}` : undefined}
                        className="px-3 py-1 bg-white rounded-full text-xs font-medium text-on-surface border border-slate-200"
                      >
                        {e.value}
                        {e.page && <span className="text-[9px] font-bold text-slate-400 ml-1.5">p.{e.page}</span>}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ─── Right: source panel and issues ───────────────── */}
        <div ref={sideRef} className="lg:col-span-5 space-y-8 lg:sticky lg:top-28 min-w-0 lg:max-h-[calc(100vh-13rem)] lg:overflow-y-auto lg:overscroll-contain lg:rounded-[32px] lg:pb-2" data-testid="side-column">
          <div ref={sourceRef} className="scroll-mt-24">
            <AnimatePresence mode="wait">
              {selected ? (
                <motion.div
                  key={selected.key}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="bg-white p-6 md:p-8 rounded-[32px] border border-primary/20 shadow-sm space-y-5"
                  data-testid="source-panel"
                  aria-live="polite"
                >
                  <div className="flex justify-between items-start gap-4">
                    <div className="min-w-0">
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant opacity-50">Source</p>
                      <p className="text-xl font-headline font-bold mt-1 break-words">{selected.label}</p>
                    </div>
                    <button
                      onClick={() => onSelectField(null)}
                      aria-label="Close source panel"
                      className="w-9 h-9 rounded-xl bg-surface-container-highest flex items-center justify-center hover:bg-primary hover:text-white transition-all shrink-0"
                    >
                      <span className="material-symbols-outlined text-sm">close</span>
                    </button>
                  </div>
                  <div>
                    <p className="text-sm font-medium break-words">{display(selected) ?? 'Not found in the document'}</p>
                    {selected.normalizedValue != null && !Array.isArray(selected.normalizedValue) && String(selected.normalizedValue) !== selected.value && (
                      <p className="text-[10px] text-on-surface-variant mt-1">Normalised: <span className="font-mono">{String(selected.normalizedValue)}</span></p>
                    )}
                  </div>
                  {doc.hasFile && selected.value != null && (
                    <PagePreview docId={doc.id} page={selected.page} quote={selected.sourceQuote} value={selected.value} box={selected.box} />
                  )}
                  {selected.sourceQuote ? (
                    <blockquote className="border-l-4 border-primary bg-surface-container-low rounded-r-2xl px-4 py-3 text-sm text-on-surface leading-relaxed break-words">
                      <QuoteWithValue quote={selected.sourceQuote} value={selected.value} />
                    </blockquote>
                  ) : (
                    <p className="text-xs text-on-surface-variant italic">No source quote: this field was not found in the document.</p>
                  )}
                  <div className="flex flex-wrap gap-2 items-center">
                    <ConfidenceChip value={selected.confidence} band={selected.confidenceBand} />
                    {selected.page && (
                      <span className="px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border bg-slate-100 text-slate-500 border-slate-200">Page {selected.page}</span>
                    )}
                    {selected.confidenceDetail?.source && (
                      <span className="px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-widest border bg-slate-100 text-slate-500 border-slate-200">
                        {selected.confidenceDetail.source === 'ocr' ? 'Read by OCR' : 'PDF text layer'}
                      </span>
                    )}
                  </div>
                  {selected.confidenceDetail && selected.value != null && (
                    <div className="space-y-2" aria-label="How the confidence was calculated">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">How the confidence was calculated</p>
                      {[
                        ['AI certainty', selected.confidenceDetail.model, '50%'],
                        ['Quote found in document', selected.confidenceDetail.verification, '30%'],
                        ['Format & consistency checks', selected.confidenceDetail.validation, '20%'],
                      ].map(([label, v, weight]) => (
                        <div key={label as string}>
                          <div className="flex justify-between text-[10px] text-on-surface-variant mb-1">
                            <span>{label} <span className="opacity-60">× {weight}</span></span>
                            <span className="font-mono">{percent(v as number)}</span>
                          </div>
                          <div className="h-1.5 w-full bg-surface-container-highest rounded-full overflow-hidden">
                            <div className="h-full rounded-full bg-gradient-to-r from-primary to-secondary" style={{ width: percent(v as number) }} />
                          </div>
                        </div>
                      ))}
                      {selected.confidenceDetail.capped?.includes('ocr') && (
                        <p className="text-[10px] text-on-surface-variant">Capped at 90%: values read by OCR cannot be checked against a text layer.</p>
                      )}
                      {selected.confidenceDetail.capped?.includes('unverified') && (
                        <p className="text-[10px] text-red-500 font-medium">Capped at 40%: neither the quote nor the value could be found in the document.</p>
                      )}
                    </div>
                  )}
                </motion.div>
              ) : focus ? (
                <motion.div
                  key={`focus-${focus.page}-${focus.quote}`}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="bg-white p-6 md:p-8 rounded-[32px] border border-primary/20 shadow-sm space-y-5"
                  data-testid="source-panel"
                  aria-live="polite"
                >
                  <div className="flex justify-between items-start gap-4">
                    <div className="min-w-0">
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant opacity-50">Source</p>
                      <p className="text-xl font-headline font-bold mt-1 break-words">{focus.label || (focus.page ? `Page ${focus.page}` : 'Cited passage')}</p>
                    </div>
                    <button
                      onClick={onClearFocus}
                      aria-label="Close source panel"
                      className="w-9 h-9 rounded-xl bg-surface-container-highest flex items-center justify-center hover:bg-primary hover:text-white transition-all shrink-0"
                    >
                      <span className="material-symbols-outlined text-sm">close</span>
                    </button>
                  </div>
                  {doc.hasFile && focus.page && <PagePreview docId={doc.id} page={focus.page} quote={focus.quote} value={null} />}
                  <blockquote className="border-l-4 border-primary bg-surface-container-low rounded-r-2xl px-4 py-3 text-sm text-on-surface leading-relaxed break-words">
                    {focus.quote}
                  </blockquote>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          <div className="bg-surface-container-low p-6 md:p-8 rounded-[32px] border border-slate-200 shadow-sm space-y-5" data-testid="issues-panel">
            <div className="flex justify-between items-center gap-4">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant opacity-50">Validation</p>
                <p className="text-xl font-headline font-bold mt-1">Issues</p>
              </div>
              <div className="flex gap-1.5">
                {(['error', 'warning', 'info'] as const).map(s => counts[s] > 0 && (
                  <span key={s} className={cn('flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black uppercase border', SEVERITY[s].box, SEVERITY[s].text)}>
                    <span className="material-symbols-outlined text-[12px]">{SEVERITY[s].icon}</span>
                    {counts[s]}
                  </span>
                ))}
              </div>
            </div>
            {doc.issues.length === 0 ? (
              <div className="flex items-center gap-3 text-sm text-tertiary font-medium">
                <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                No missing or inconsistent information found.
              </div>
            ) : (
              ISSUE_GROUPS.map(group => {
                const list = doc.issues.filter(i => i.type === group.type);
                if (!list.length) return null;
                return (
                  <div key={group.type} className="space-y-2">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">{group.label} · {list.length}</p>
                    {list.map((issue, i) => {
                      const s = SEVERITY[issue.severity];
                      const target = issue.fieldKeys.find(k => doc.fields.some(f => f.key === k));
                      const content = (
                        <>
                          <span className={cn('material-symbols-outlined text-lg shrink-0', s.text)}>{s.icon}</span>
                          <span className="text-xs text-on-surface leading-relaxed">
                            <span className={cn('font-bold uppercase text-[9px] tracking-widest mr-1.5', s.text)}>{issue.severity}</span>
                            {issue.message}
                          </span>
                        </>
                      );
                      return target ? (
                        <button
                          key={i}
                          onClick={() => onSelectField(target)}
                          className={cn('w-full text-left flex gap-3 items-start px-4 py-3 rounded-2xl border hover:shadow-sm transition-shadow', s.box)}
                          aria-label={`${issue.severity}: ${issue.message} Show field.`}
                          data-testid="issue-item"
                        >
                          {content}
                        </button>
                      ) : (
                        <div key={i} className={cn('flex gap-3 items-start px-4 py-3 rounded-2xl border', s.box)} data-testid="issue-item">
                          {content}
                        </div>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
