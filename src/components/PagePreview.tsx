import { useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';
import { boxToRect, findTextRects, loadSource, renderPdfPage, type Rect } from '../lib/preview';

interface PagePreviewProps {
  docId: string;
  page: number | null;
  quote: string | null;
  value: string | null;
  /** AI bounding box [ymin, xmin, ymax, xmax] on 0-1000, for scans and photos. */
  box?: number[] | null;
  /** Areas to black out (PII masking). */
  redactions?: Rect[];
  className?: string;
}

type Located = 'text' | 'ai' | 'none';

/**
 * The page a value came from, with the value highlighted: exact for PDF text
 * layers, approximate (AI-located) for scans and photos.
 */
export function PagePreview({ docId, page, quote, value, box, redactions = [], className }: PagePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [kind, setKind] = useState<'pdf' | 'image' | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [rects, setRects] = useState<Rect[]>([]);
  const [located, setLocated] = useState<Located>('none');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setRects([]);
    setLocated('none');
    (async () => {
      try {
        const src = await loadSource(docId);
        if (cancelled) return;
        setKind(src.kind);
        let found: Rect[] = [];
        let how: Located = 'none';
        if (src.kind === 'pdf') {
          const canvas = canvasRef.current;
          if (!canvas || cancelled) return;
          const width = Math.max(320, frameRef.current?.clientWidth || 480);
          const { page: pdfPage, viewport, numPages } = await renderPdfPage(docId, page || 1, canvas, width);
          if (cancelled) return;
          setPageCount(numPages);
          found = await findTextRects(pdfPage, viewport, quote, value);
          if (found.length) how = 'text';
        } else {
          setImageUrl(src.url);
        }
        if (!found.length && box?.length === 4) {
          found = [boxToRect(box)];
          how = 'ai';
        }
        if (cancelled) return;
        setRects(found);
        setLocated(how);
        setStatus('ready');
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'The page could not be shown.');
          setStatus('error');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [docId, page, quote, value, box?.join(',')]);

  // Bring the highlight into view inside the scrollable frame.
  useEffect(() => {
    const scroller = scrollRef.current;
    const frame = frameRef.current;
    if (status !== 'ready' || !rects.length || !scroller || !frame) return;
    const t = setTimeout(() => {
      const top = (rects[0].top / 100) * frame.clientHeight;
      scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 3), behavior: 'smooth' });
    }, 50);
    return () => clearTimeout(t);
  }, [status, rects]);

  return (
    <div className={cn('space-y-2', className)} data-testid="page-preview">
      <div ref={scrollRef} className="relative max-h-[340px] overflow-auto rounded-2xl border border-slate-200 bg-surface-container-low">
        <div ref={frameRef} className="relative w-full">
          <canvas ref={canvasRef} className={kind === 'pdf' ? 'block w-full' : 'hidden'} aria-label={`Page ${page || 1} of the document`} />
          {kind === 'image' && imageUrl && <img src={imageUrl} alt="Uploaded page" className="block w-full h-auto" />}
          {status === 'ready' && rects.map((r, i) => (
            <div
              key={i}
              className={cn('absolute rounded-md border-2 pointer-events-none', located === 'ai' ? 'border-secondary bg-secondary/15' : 'border-primary bg-primary/20')}
              style={{ left: `${r.left - 0.4}%`, top: `${r.top - 0.3}%`, width: `${r.width + 0.8}%`, height: `${r.height + 0.6}%`, boxShadow: '0 0 0 4px rgba(8,145,178,0.12)' }}
              data-testid="source-highlight"
            />
          ))}
          {status === 'ready' && redactions.map((r, i) => (
            <div key={`r${i}`} className="absolute bg-slate-900 rounded-sm pointer-events-none" style={{ left: `${r.left}%`, top: `${r.top}%`, width: `${r.width}%`, height: `${r.height}%` }} data-testid="redaction-box" />
          ))}
          {status === 'loading' && (
            <div className="flex items-center justify-center py-16">
              <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
            </div>
          )}
          {status === 'error' && (
            <div className="flex flex-col items-center justify-center text-center py-10 px-6 text-slate-400">
              <span className="material-symbols-outlined text-4xl mb-2 text-slate-300">image_not_supported</span>
              <p className="text-xs">{error}</p>
            </div>
          )}
        </div>
      </div>
      {status === 'ready' && (
        <p className="text-[10px] text-on-surface-variant" data-testid="preview-caption">
          Page {page || 1}{pageCount ? ` of ${pageCount}` : ''} ·{' '}
          {located === 'text' ? 'located exactly in the PDF text layer'
            : located === 'ai' ? 'location found by the AI on the scan (approximate)'
            : quote ? 'exact position not available; see the quote below' : 'no position for this value'}
        </p>
      )}
    </div>
  );
}
