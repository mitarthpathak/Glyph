import { useEffect, useRef, useState } from 'react';
import { useDropzone, type FileRejection } from 'react-dropzone';
import { motion } from 'motion/react';
import { cn } from '../lib/utils';
import { apiFetch } from '../lib/api';
import { isHeicFile, prepareImage } from '../lib/image';
import { QUALITY_TEXT, measureImageQuality } from '../lib/quality';
import { STAGE_TEXT, createJob, fetchUploadLimitMb, pollJob, uploadToStorage, type UploadedFile } from '../lib/upload';
import type { DocumentResult, UploadStatus } from '../types';

// Per-file limit without Supabase Storage (Vercel's request-body limit); the
// server reports a larger one when files go straight to Supabase.
const DEFAULT_MAX_SIZE_MB = 4;
const MAX_FILES = 10;
// Larger originals are accepted because images are downscaled before upload.
const MAX_ORIGINAL_IMAGE_MB = 40;
// Upload to storage is the first 15% of an item's progress bar.
const UPLOAD_SHARE = 15;
const PARALLEL_UPLOADS = 3;

/** One uploaded file and its extraction result. */
export interface ExtractedUpload {
  doc: DocumentResult;
  file: File;
}

interface UploadZoneProps {
  /** `open` is false when some files failed, so their errors stay visible here. */
  onDocumentsReady: (results: ExtractedUpload[], open: boolean) => void;
  setUploads: React.Dispatch<React.SetStateAction<UploadStatus[]>>;
}

/** Runs fn over items with at most `limit` running at once. */
async function eachLimited<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function UploadZone({ onDocumentsReady, setUploads }: UploadZoneProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [batch, setBatch] = useState<{ index: number; total: number } | null>(null);
  // The whole batch: files done / failed, mean progress and the time left.
  const [overall, setOverall] = useState<{ done: number; failed: number; total: number; percent: number; eta: number | null } | null>(null);
  const tracked = useRef(new Map<string, { progress: number; status: UploadStatus['status'] }>());
  const batchStartedAt = useRef(0);
  const [maxSizeMb, setMaxSizeMb] = useState(DEFAULT_MAX_SIZE_MB);
  const busy = useRef(false);

  useEffect(() => {
    fetchUploadLimitMb().then(mb => mb && setMaxSizeMb(mb));
  }, []);

  const updateUpload = (id: string, patch: Partial<UploadStatus>) => {
    setUploads(prev => prev.map(u => (u.id === id ? { ...u, ...patch } : u)));
    const item = tracked.current.get(id);
    if (!item) return;
    Object.assign(item, patch.progress != null ? { progress: patch.progress } : {}, patch.status ? { status: patch.status } : {});
    const items = [...tracked.current.values()];
    const done = items.filter(i => i.status === 'completed').length;
    const failed = items.filter(i => i.status === 'failed').length;
    const percent = Math.round(items.reduce((a, i) => a + (i.status === 'failed' || i.status === 'completed' ? 100 : i.progress), 0) / items.length);
    const elapsed = (Date.now() - batchStartedAt.current) / 1000;
    const eta = percent >= 10 && percent < 100 ? Math.max(1, Math.round((elapsed * (100 - percent)) / percent)) : null;
    setOverall({ done, failed, total: items.length, percent, eta });
  };
  const removeUploadLater = (id: string, ms: number) =>
    setTimeout(() => setUploads(prev => prev.filter(u => u.id !== id)), ms);

  /**
   * The batch: every file is uploaded to storage (a few in parallel), then one
   * server job extracts them all while this polls its progress. Each file is
   * processed and saved independently; one failing does not stop the others.
   */
  const handleFiles = async (files: File[]) => {
    if (busy.current || files.length === 0) return;
    busy.current = true;
    setUploads(prev => prev.filter(u => u.status !== 'completed' && u.status !== 'failed'));
    setLoading(true);
    setError(null);
    setNotice(null);
    setBatch(files.length > 1 ? { index: 1, total: files.length } : null);

    const keys = files.map(() => `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tracked.current = new Map(keys.map(k => [k, { progress: 0, status: 'uploading' as const }]));
    batchStartedAt.current = Date.now();
    setOverall(files.length > 1 ? { done: 0, failed: 0, total: files.length, percent: 0, eta: null } : null);
    setUploads(prev => [...prev, ...files.map((f, i) => ({ id: keys[i], fileName: f.name, progress: 0, status: 'uploading' as const, subtext: 'Uploading document' }))]);

    const errors: string[] = [];
    const warnings = new Set<string>();
    const done: ExtractedUpload[] = [];
    const fail = (i: number, message: string) => {
      errors.push(files.length > 1 ? `${files[i].name}: ${message}` : message);
      updateUpload(keys[i], { status: 'failed', subtext: message.length > 60 ? 'Upload failed' : message });
      removeUploadLater(keys[i], 8000);
    };

    try {
      // 1. Upload to storage.
      const uploaded: (UploadedFile & { index: number })[] = [];
      await eachLimited(files, PARALLEL_UPLOADS, async (original, i) => {
        try {
          // Quality of the original photo (before downscaling): warn now, and the server flags it too.
          const quality = await measureImageQuality(original).catch(() => null);
          if (quality?.warnings.length) {
            const text = quality.warnings.map(w => QUALITY_TEXT[w]).join(' · ');
            updateUpload(keys[i], { warning: `${text}: results may be less accurate` });
            warnings.add(`${original.name}: ${text.toLowerCase()}. Values read from it may be less accurate; retake the photo in focus and in good light if you can.`);
          }
          const file = await prepareImage(original);
          const path = await uploadToStorage(file, f => updateUpload(keys[i], { progress: f * UPLOAD_SHARE, subtext: `Uploading document · ${Math.round(f * 100)}%` }));
          updateUpload(keys[i], { progress: UPLOAD_SHARE, status: 'analyzing', subtext: STAGE_TEXT.queued });
          uploaded.push({ index: i, path, filename: original.name, mimeType: file.type, size: file.size, quality: quality as Record<string, unknown> | null });
        } catch (err: any) {
          fail(i, err?.message || 'Something went wrong. Please try again.');
        }
      });

      // 2. One job for the batch, polled until every file is finished.
      if (uploaded.length) {
        uploaded.sort((a, b) => a.index - b.index);
        const job = await createJob(uploaded.map(({ index, ...u }) => u));
        const indexOf = new Map(job.items.map((it, n) => [it.id, uploaded[n].index]));
        const extractingSince = new Map<string, number>();
        const finished = new Set<string>();
        await pollJob(job.id, async current => {
          setBatch(files.length > 1 ? { index: Math.min(current.done + 1, current.total) + (files.length - uploaded.length), total: files.length } : null);
          for (const item of current.items) {
            const i = indexOf.get(item.id);
            if (i === undefined || finished.has(item.id)) continue;
            if (item.status === 'failed') {
              finished.add(item.id);
              fail(i, item.error || 'This file could not be read.');
            } else if (item.status === 'done' && item.documentId) {
              finished.add(item.id);
              try {
                const doc = await apiFetch<DocumentResult>(`/documents/${encodeURIComponent(item.documentId)}`);
                if (item.warning) doc.warning = item.warning;
                if (item.cached) doc.cached = true;
                done.push({ doc, file: files[i] });
                if (item.warning) warnings.add(item.warning);
                updateUpload(keys[i], {
                  progress: 100,
                  status: 'completed',
                  subtext: item.cached ? 'Loaded from previous analysis' : doc.fallbackUsed ? 'Basic extraction (AI unavailable)' : `${doc.docTypeLabel} extracted`,
                });
                removeUploadLater(keys[i], 5000);
              } catch (err: any) {
                fail(i, err?.message || 'The result could not be loaded.');
              }
            } else {
              // The AI call reports no progress: estimate it from the time spent so far.
              let progress = UPLOAD_SHARE + (item.progress / 100) * (100 - UPLOAD_SHARE);
              if (item.stage === 'extracting') {
                if (!extractingSince.has(item.id)) extractingSince.set(item.id, Date.now());
                const t = (Date.now() - extractingSince.get(item.id)!) / 1000;
                progress += (1 - Math.exp(-t / 14)) * 55;
              }
              updateUpload(keys[i], { progress: Math.min(progress, 95), status: 'analyzing', subtext: STAGE_TEXT[item.stage || 'queued'] || STAGE_TEXT.queued });
            }
          }
        });
      }
    } catch (err: any) {
      setError(err?.message || 'Something went wrong. Please try again.');
    } finally {
      busy.current = false;
      setBatch(null);
      setOverall(null);
      setLoading(false);
    }

    if (errors.length) setError(errors.join(' '));
    if (warnings.size) setNotice([...warnings].join(' '));
    // Results in the order the files were chosen.
    done.sort((a, b) => files.indexOf(a.file) - files.indexOf(b.file));
    // Short pause so the 100% state is visible before switching screens.
    // With some files failed, stay here so the errors can be read.
    if (done.length && !errors.length) {
      setTimeout(() => onDocumentsReady(done, true), warnings.size ? 1800 : 600);
    } else if (done.length) {
      onDocumentsReady(done, false);
    }
  };

  const onDropRejected = (rejections: FileRejection[]) => {
    const first = rejections[0];
    const code = first?.errors[0]?.code;
    setNotice(null);
    setError(
      code === 'too-many-files' ? `Please upload at most ${MAX_FILES} files at a time.` :
      first && isHeicFile(first.file) ? 'HEIC photos are not supported. Please export them as JPG or PNG.' :
      code === 'file-too-large' ? `"${first.file.name}" is too large. Maximum size is ${/\.pdf$/i.test(first.file.name) ? maxSizeMb : Math.max(maxSizeMb, MAX_ORIGINAL_IMAGE_MB)} MB.` :
      code === 'file-invalid-type' ? 'Only PDF, PNG, JPG and WEBP files are supported.' :
      'This file cannot be uploaded.'
    );
  };

  // Images may be larger than the limit because they are downscaled before upload.
  const validator = (file: File) => {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const limitMb = isPdf ? maxSizeMb : Math.max(maxSizeMb, MAX_ORIGINAL_IMAGE_MB);
    return file.size > limitMb * 1024 * 1024
      ? { code: 'file-too-large', message: `File is larger than ${limitMb} MB` }
      : null;
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    // Valid files are uploaded; rejected ones are reported by onDropRejected.
    onDrop: files => handleFiles(files),
    onDropRejected,
    accept: {
      'application/pdf': ['.pdf'],
      'image/png': ['.png'],
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/webp': ['.webp'],
    },
    validator,
    maxFiles: MAX_FILES,
    multiple: true,
    disabled: loading,
  });

  return (
    <div {...getRootProps()} className={cn('relative group w-full', loading ? 'cursor-wait' : 'cursor-pointer')} data-testid="upload-zone">
      <motion.div
        className={cn(
          'absolute -inset-0.5 bg-gradient-to-br from-primary to-secondary rounded-xl blur transition duration-500',
          isDragActive ? 'opacity-40' : 'opacity-10 group-hover:opacity-25'
        )}
      />
      <div className="relative glass-panel border border-slate-200 rounded-xl p-6 sm:p-8 md:p-10 flex flex-col items-center justify-center text-center min-h-[320px]">
        <input {...getInputProps()} data-testid="file-input" />
        {loading ? (
          <div className="flex flex-col items-center">
            <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4"></div>
            <h3 className="text-xl font-headline mb-2 text-primary">
              {batch ? `Processing ${batch.index} of ${batch.total}...` : 'Processing Document...'}
            </h3>
            <p className="text-on-surface-variant text-sm">The AI is reading your document. This usually takes 10–40 seconds.</p>
            {overall && (
              <div className="w-full max-w-sm mt-6 space-y-2" data-testid="batch-progress">
                <div className="flex flex-wrap lg:flex-nowrap justify-between gap-4 gap-y-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
                  <span>{overall.done} of {overall.total} done{overall.failed ? ` · ${overall.failed} failed` : ''}</span>
                  <span className="ml-auto font-mono">{overall.percent}%{overall.eta != null ? ` · ~${overall.eta}s left` : ''}</span>
                </div>
                <div className="h-1.5 w-full bg-surface-container-highest rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-gradient-to-r from-primary to-secondary transition-all duration-500" style={{ width: `${overall.percent}%` }} />
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mb-6">
              <span className="material-symbols-outlined text-primary text-4xl" style={{ fontVariationSettings: "'FILL' 1" }}>
                upload_file
              </span>
            </div>
            <h3 className="text-xl font-headline mb-2">Upload a Document</h3>
            {error ? (
              <p role="alert" className="text-red-500 text-sm font-medium mb-2 px-4 py-2 bg-red-50 rounded-lg border border-red-100">
                {error}
              </p>
            ) : notice ? (
              <p className="text-amber-700 text-sm font-medium mb-2 px-4 py-2 bg-amber-50 rounded-lg border border-amber-100">
                {notice}
              </p>
            ) : (
              <p className="text-on-surface-variant max-w-[260px]">
                {isDragActive ? 'Drop the file here...' : (
                  <>Drag PDFs, scans or photos here or <span className="text-primary hover:underline">browse files</span></>
                )}
              </p>
            )}
            <div className="mt-8 flex gap-2">
              <span className="px-3 py-1 rounded-full bg-surface-container-highest text-[10px] text-primary border border-primary/20 uppercase tracking-widest font-bold">PDF · Images</span>
              <span className="px-3 py-1 rounded-full bg-surface-container-highest text-[10px] text-secondary border border-secondary/20 uppercase tracking-widest font-bold">Max {maxSizeMb}MB</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
