/** Signed upload followed by one processing request per file/page chunk and status polling. */
import { ApiError, apiFetch, authHeaders } from './api';

export interface JobItem {
  id: string;
  filename: string;
  size?: number;
  status: 'queued' | 'running' | 'done' | 'failed';
  stage?: string;
  progress: number;
  processable?: boolean;
  error?: string;
  warning?: string;
  documentId?: string;
  cached?: boolean;
  elapsedMs?: number;
}

export interface Job {
  id: string;
  status: 'running' | 'done' | 'failed' | 'partial';
  done: number;
  total: number;
  items: JobItem[];
}

export interface UploadedFile {
  path: string;
  filename: string;
  mimeType: string;
  size: number;
  quality?: Record<string, unknown> | null;
}

const POLL_MS = 1200;

/** XMLHttpRequest instead of fetch, for upload progress events. */
function send(url: string, method: string, headers: Headers | Record<string, string>, body: XMLHttpRequestBodyInit, onProgress: (fraction: number) => void) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
    for (const [k, v] of entries) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => reject(new ApiError('Could not reach the server. Check your internet connection and try again.', 0));
    xhr.send(body);
  });
}

const readError = (text: string, status: number) => {
  try {
    const data = JSON.parse(text);
    return data.error || data.message || `Upload failed (${status}).`;
  } catch {
    return status === 413 ? 'File is too large. Maximum size is 4 MB.' : `Upload failed (${status}).`;
  }
};

type UploadTarget =
  | { mode: 'supabase'; path: string; uploadUrl: string; method: string; headers: Record<string, string>; maxBytes: number }
  | { mode: 'direct'; maxBytes: number };

/** Upload one file to storage; resolves to its storage path. */
export async function uploadToStorage(file: File, onProgress: (fraction: number) => void): Promise<string> {
  const target = await apiFetch<UploadTarget & { success: boolean }>('/uploads/sign', {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, mimeType: file.type, size: file.size }),
  });
  if (file.size > target.maxBytes) {
    throw new ApiError(`"${file.name}" is too large. Maximum size is ${Math.round(target.maxBytes / 1024 / 1024)} MB.`, 413);
  }
  if (target.mode === 'supabase') {
    const res = await send(target.uploadUrl, target.method || 'PUT', target.headers, file, onProgress);
    if (res.status >= 300) throw new ApiError(readError(res.text, res.status), res.status);
    return target.path;
  }
  const form = new FormData();
  form.append('file', file);
  const res = await send('/api/uploads', 'POST', authHeaders(), form, onProgress);
  let data: any = null;
  try {
    data = JSON.parse(res.text);
  } catch {
    /* not JSON */
  }
  if (res.status >= 300 || !data?.success) throw new ApiError(data?.error || readError(res.text, res.status), res.status);
  return data.path;
}

export async function createJob(items: UploadedFile[]): Promise<Job> {
  const data = await apiFetch<{ job: Job }>('/jobs', { method: 'POST', body: JSON.stringify({ items }) });
  return data.job;
}

/** Poll a job until no item is queued or running; onUpdate sees every state. */
export async function pollJob(id: string, onUpdate: (job: Job) => void | Promise<void>): Promise<Job> {
  let failures = 0;
  const inFlight = new Set<string>();
  const processFailures = new Map<string, number>();
  let processingError: unknown;
  for (;;) {
    if (processingError) throw processingError;
    let job: Job;
    try {
      job = (await apiFetch<{ job: Job }>(`/jobs/${encodeURIComponent(id)}`)).job;
      failures = 0;
    } catch (err) {
      // Brief network or server hiccups should not lose the batch.
      if (++failures >= 5 || (err instanceof ApiError && err.status === 404)) throw err;
      await new Promise(r => setTimeout(r, POLL_MS * failures));
      continue;
    }
    await onUpdate(job);
    if (job.status !== 'running') return job;
    for (const item of job.items) {
      if (inFlight.size >= 3) break;
      if (!item.processable || inFlight.has(item.id)) continue;
      inFlight.add(item.id);
      void apiFetch(`/jobs/${encodeURIComponent(id)}/items/${encodeURIComponent(item.id)}/process`, { method: 'POST' })
        .then(() => { processFailures.delete(item.id); })
        .catch(err => {
          const count = (processFailures.get(item.id) || 0) + 1;
          processFailures.set(item.id, count);
          if (count >= 5) processingError = err;
        })
        .finally(() => { inFlight.delete(item.id); });
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

/** Largest upload the server accepts per file (bigger with Supabase Storage). */
export async function fetchUploadLimitMb(): Promise<number | null> {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    return typeof data.uploadLimitMb === 'number' ? data.uploadLimitMb : null;
  } catch {
    return null;
  }
}

/** Status line for an item's processing stage. */
export const STAGE_TEXT: Record<string, string> = {
  queued: 'Queued',
  downloading: 'Fetching the file from storage',
  reading: 'Reading text (OCR for scans and photos)',
  extracting: 'Classifying and extracting fields with Gemini AI',
  validating: 'Checking confidence and consistency',
  saving: 'Saving results',
};
