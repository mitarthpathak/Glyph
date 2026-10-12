import { useRef, useState } from 'react';
import { useDropzone, type FileRejection } from 'react-dropzone';
import { motion } from 'motion/react';
import { cn } from '../lib/utils';
import { apiFetch } from '../lib/api';
import { MAX_UPLOAD_BYTES, isHeicFile, prepareImage } from '../lib/image';
import type { SavedGraph, UploadStatus } from '../types';

const MAX_SIZE_MB = 4;
const MAX_FILES = 10;
// Larger originals are accepted because images are downscaled before upload.
const MAX_ORIGINAL_IMAGE_MB = 40;

const STAGES = [
  { until: 15, text: 'Uploading document' },
  { until: 35, text: 'Reading text (OCR for scans and photos)' },
  { until: 70, text: 'Analyzing concepts with Gemini AI' },
  { until: 92, text: 'Building knowledge graph' },
];

interface UploadZoneProps {
  onGraphReady: (data: SavedGraph) => void;
  setUploads: React.Dispatch<React.SetStateAction<UploadStatus[]>>;
}

export function UploadZone({ onGraphReady, setUploads }: UploadZoneProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [batch, setBatch] = useState<{ index: number; total: number } | null>(null);
  const busy = useRef(false);

  const updateUpload = (id: string, patch: Partial<UploadStatus>) =>
    setUploads(prev => prev.map(u => (u.id === id ? { ...u, ...patch } : u)));
  const removeUploadLater = (id: string, ms: number) =>
    setTimeout(() => setUploads(prev => prev.filter(u => u.id !== id)), ms);

  /** Uploads one file; resolves to the saved result or null on failure (error is reported). */
  const uploadOne = async (original: File): Promise<(SavedGraph & { warning?: string }) | null> => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setUploads(prev => [...prev, { id, fileName: original.name, progress: 0, status: 'uploading', subtext: STAGES[0].text }]);

    // The server does not stream progress, so advance an estimate that slows
    // down as it approaches the end (typical analysis takes 10-40 s).
    let progress = 0;
    const timer = setInterval(() => {
      progress += Math.max(0.3, (92 - progress) * 0.04);
      progress = Math.min(progress, 92);
      const stage = STAGES.find(s => progress <= s.until) || STAGES[STAGES.length - 1];
      updateUpload(id, { progress, status: progress > 15 ? 'analyzing' : 'uploading', subtext: stage.text });
    }, 500);

    try {
      const file = await prepareImage(original);
      if (file.size > MAX_UPLOAD_BYTES) throw new Error(`"${original.name}" is too large. Maximum size is ${MAX_SIZE_MB} MB.`);
      const formData = new FormData();
      formData.append('pdf', file);
      const data = await apiFetch<SavedGraph & { warning?: string; cached?: boolean }>('/upload', { method: 'POST', body: formData });
      clearInterval(timer);
      updateUpload(id, {
        progress: 100,
        status: 'completed',
        subtext: data.cached ? 'Loaded from previous analysis' : data.fallbackUsed ? 'Basic keyword map generated' : 'Knowledge graph ready',
      });
      removeUploadLater(id, 5000);
      return data;
    } catch (err: any) {
      clearInterval(timer);
      updateUpload(id, { status: 'failed', subtext: 'Upload failed' });
      removeUploadLater(id, 8000);
      throw err;
    }
  };

  /** Each file is processed (and saved) independently, one after another. */
  const handleFiles = async (files: File[]) => {
    if (busy.current || files.length === 0) return;
    busy.current = true;
    setUploads(prev => prev.filter(u => u.status !== 'completed' && u.status !== 'failed'));
    setLoading(true);
    setError(null);
    setNotice(null);

    let last: (SavedGraph & { warning?: string }) | null = null;
    const errors: string[] = [];
    const warnings = new Set<string>();
    try {
      for (let i = 0; i < files.length; i++) {
        setBatch(files.length > 1 ? { index: i + 1, total: files.length } : null);
        try {
          const data = await uploadOne(files[i]);
          if (data) {
            last = data;
            if (data.warning) warnings.add(data.warning);
          }
        } catch (err: any) {
          const message = err?.message || 'Something went wrong. Please try again.';
          errors.push(files.length > 1 ? `${files[i].name}: ${message}` : message);
        }
      }
    } finally {
      busy.current = false;
      setBatch(null);
      setLoading(false);
    }

    if (errors.length) setError(errors.join(' '));
    if (warnings.size) setNotice([...warnings].join(' '));
    // Short pause so the 100% state is visible before switching screens.
    if (last && !errors.length) {
      const result = last;
      setTimeout(() => onGraphReady(result), warnings.size ? 1800 : 600);
    }
  };

  const onDropRejected = (rejections: FileRejection[]) => {
    const first = rejections[0];
    const code = first?.errors[0]?.code;
    setNotice(null);
    setError(
      code === 'too-many-files' ? `Please upload at most ${MAX_FILES} files at a time.` :
      first && isHeicFile(first.file) ? 'HEIC photos are not supported. Please export them as JPG or PNG.' :
      code === 'file-too-large' ? `"${first.file.name}" is too large. Maximum size is ${/\.pdf$/i.test(first.file.name) ? MAX_SIZE_MB : MAX_ORIGINAL_IMAGE_MB} MB.` :
      code === 'file-invalid-type' ? 'Only PDF, PNG, JPG and WEBP files are supported.' :
      'This file cannot be uploaded.'
    );
  };

  // Images may be larger than the limit because they are downscaled before upload.
  const validator = (file: File) => {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const limitMb = isPdf ? MAX_SIZE_MB : MAX_ORIGINAL_IMAGE_MB;
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
      <div className="relative glass-panel border border-slate-200 rounded-xl p-8 md:p-10 flex flex-col items-center justify-center text-center min-h-[320px]">
        <input {...getInputProps()} data-testid="file-input" />
        {loading ? (
          <div className="flex flex-col items-center">
            <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4"></div>
            <h3 className="text-xl font-headline mb-2 text-primary">
              {batch ? `Processing ${batch.index} of ${batch.total}...` : 'Processing Document...'}
            </h3>
            <p className="text-on-surface-variant text-sm">The AI is reading your document. This usually takes 10–40 seconds.</p>
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
                  <>Drag PDFs or images here or <span className="text-primary hover:underline">browse files</span></>
                )}
              </p>
            )}
            <div className="mt-8 flex gap-2">
              <span className="px-3 py-1 rounded-full bg-surface-container-highest text-[10px] text-primary border border-primary/20 uppercase tracking-widest font-bold">PDF · Images</span>
              <span className="px-3 py-1 rounded-full bg-surface-container-highest text-[10px] text-secondary border border-secondary/20 uppercase tracking-widest font-bold">Max {MAX_SIZE_MB}MB</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
