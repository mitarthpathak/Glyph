/** Request-driven extraction: one file or PDF chunk per POST, with MongoDB checkpoints. */
import crypto from 'crypto';
import { createJob, getJob, leaseJobItem, updateJobItem } from './db.js';
import { getObject, maxUploadBytes } from './storage.js';
import { processDocument } from './processDocument.js';
import { processPdfChunk } from './pdfChunks.js';
import { detectFileType } from './files.js';
import { ownerFields } from './owner.js';

export const MAX_JOB_ITEMS = 10;
// Items of one job processed at the same time.
export const JOB_CONCURRENCY = 3;
// Longer than one item can take (download + 48 s AI budget + validation + save).
const LEASE_MS = 75_000;
const AI_BUDGET_MS = 48_000;
const MAX_ATTEMPTS = 2;

/** Rough progress per stage, shown while an item is processed. */
export const STAGE_PROGRESS = { queued: 0, downloading: 8, reading: 18, extracting: 30, validating: 90, saving: 96, done: 100 };

export async function createExtractionJob(owner, items) {
  return createJob({
    ...ownerFields(owner),
    items: items.map(i => ({
      id: crypto.randomBytes(6).toString('hex'),
      filename: i.filename,
      mimeType: i.mimeType,
      size: i.size,
      storagePath: i.path,
      storageDriver: i.driver,
      quality: i.quality || null,
      status: 'queued',
      stage: 'queued',
      progress: 0,
      attempts: 0,
    })),
  });
}

const leaseValid = item => item.leaseUntil && new Date(item.leaseUntil) > new Date();

/** Lease and await exactly one item in this HTTP invocation. */
export async function processJobItem(job, itemId) {
  const item = job.items.find(i => i.id === itemId);
  if (!item) return;
  const stale = item.status === 'running' && !leaseValid(item);
  if (stale && (item.attempts || 0) >= MAX_ATTEMPTS) {
    await updateJobItem(job._id, item.id, { status: 'failed', stage: 'failed', error: 'Processing took too long. Please try uploading this file again.', finishedAt: new Date() }, { leaseUntil: item.leaseUntil });
    return;
  }
  const leased = await leaseJobItem(job._id, item.id, LEASE_MS);
  if (leased) await runItem(leased, item.id);
}

/** Process one leased item. Never throws: failures are recorded on the item. */
export async function runItem(job, itemId) {
  const item = job.items.find(i => i.id === itemId);
  const startedAt = Date.now();
  const set = async patch => {
    const updated = await updateJobItem(job._id, itemId, patch, { leaseUntil: item.leaseUntil });
    if (!updated) throw new Error('Processing lease is no longer owned by this request');
    return updated;
  };
  const fail = error => set({ status: 'failed', stage: 'failed', error, finishedAt: new Date(), elapsedMs: Date.now() - startedAt });
  try {
    await set({ stage: 'downloading', progress: STAGE_PROGRESS.downloading });
    const ref = { path: item.storagePath, driver: item.storageDriver, mimeType: item.mimeType, size: item.size };
    const buffer = await getObject(ref);
    if (!buffer) return await fail('The uploaded file could not be found. Please upload it again.');
    if (buffer.length > maxUploadBytes()) return await fail(`File is too large. Maximum size is ${Math.round(maxUploadBytes() / 1024 / 1024)} MB.`);
    const owner = job.userId ? { _id: job.userId } : job.guestId ? { guestId: job.guestId } : null;
    const fileType = detectFileType(buffer, { originalname: item.filename, mimetype: item.mimeType }, { maxBytes: maxUploadBytes() });
    const process = fileType.kind === 'pdf' ? processPdfChunk : processDocument;
    const result = await process(
      { buffer, originalname: item.filename, mimetype: item.mimeType, size: buffer.length },
      {
        owner,
        maxBytes: maxUploadBytes(),
        requirePersistence: true,
        deadline: startedAt + AI_BUDGET_MS,
        checkpoint: item.checkpoint,
        saveCheckpoint: checkpoint => set({ checkpoint, status: 'queued', stage: 'extracting', attempts: 0, leaseUntil: null, progress: Math.round(90 * checkpoint.nextPage / checkpoint.pageCount) }),
        fileRef: { ...ref, size: buffer.length },
        quality: item.quality,
        onStage: stage => set({ stage, progress: STAGE_PROGRESS[stage] ?? 50 }),
      },
    );
    if (result.pending) return;
    if (!result.success) {
      // Keep the original: another job or saved document may still reference it.
      return await fail(result.error);
    }
    await set({
      status: 'done', stage: 'done', progress: 100, checkpoint: null, documentId: result.id, cached: Boolean(result.cached),
      ...(result.warning ? { warning: result.warning } : {}), finishedAt: new Date(), elapsedMs: Date.now() - startedAt,
    });
    console.log(`[Jobs] ${item.filename}: ${result.docType}${result.cached ? ' (cached)' : ''} in ${Date.now() - startedAt}ms`);
  } catch (err) {
    console.error('[Jobs] item failed:', err);
    await fail('Something went wrong while reading this file. Please try again.').catch(error => console.error('[Jobs] status update failed:', error.message));
  }
}

/** Overall state of a job from its items. */
export function jobStatus(job) {
  const s = job.items.map(i => i.status);
  if (s.some(x => x === 'queued' || x === 'running')) return 'running';
  if (s.every(x => x === 'done')) return 'done';
  if (s.every(x => x === 'failed')) return 'failed';
  return 'partial';
}

export function toJobResponse(job) {
  const items = job.items.map(i => ({
    id: i.id,
    filename: i.filename,
    size: i.size,
    status: i.status,
    processable: i.status === 'queued' || (i.status === 'running' && !leaseValid(i)),
    stage: i.stage,
    progress: i.progress ?? 0,
    ...(i.error ? { error: i.error } : {}),
    ...(i.warning ? { warning: i.warning } : {}),
    ...(i.documentId ? { documentId: i.documentId } : {}),
    ...(i.cached ? { cached: true } : {}),
    ...(i.elapsedMs != null ? { elapsedMs: i.elapsedMs } : {}),
    ...(i.startedAt ? { startedAt: i.startedAt } : {}),
  }));
  const done = items.filter(i => i.status === 'done' || i.status === 'failed').length;
  return { id: String(job._id), createdAt: job.createdAt, status: jobStatus(job), done, total: items.length, items };
}

export { getJob };
