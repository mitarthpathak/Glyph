/**
 * Asynchronous extraction jobs, so no request has to outlive the serverless
 * time limit (60 s on Vercel).
 *
 *   browser ──upload──▶ storage (Supabase signed URL, or POST /api/uploads)
 *   POST /api/jobs { items }      → job saved, items leased and processed in the background
 *   GET  /api/jobs/:id  (polled)  → status per item; also leases any item that is
 *                                   still queued or whose worker died (lease expired)
 *
 * Each item (one file) is processed in a single invocation with its own AI
 * budget, so a batch of any size never hits the limit. Items are leased
 * atomically (MongoDB findOneAndUpdate), so two polls never process the same
 * item; a lease that expires is retried once, then the item fails.
 */
import crypto from 'crypto';
import { createJob, getJob, leaseJobItem, updateJobItem } from './db.js';
import { getObject, deleteObject, maxUploadBytes } from './storage.js';
import { processDocument } from './processDocument.js';
import { runInBackground } from './background.js';
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

/**
 * Start (in the background) every item that is waiting, up to the
 * concurrency limit. Called when a job is created and on every poll.
 */
export async function kickJob(job) {
  let slots = JOB_CONCURRENCY - job.items.filter(i => i.status === 'running' && leaseValid(i)).length;
  for (const item of job.items) {
    if (slots <= 0) break;
    const stale = item.status === 'running' && !leaseValid(item);
    if (item.status !== 'queued' && !stale) continue;
    if (stale && (item.attempts || 0) >= MAX_ATTEMPTS) {
      await updateJobItem(job._id, item.id, { status: 'failed', stage: 'failed', error: 'Processing took too long. Please try uploading this file again.', finishedAt: new Date() });
      continue;
    }
    const leased = await leaseJobItem(job._id, item.id, LEASE_MS);
    if (!leased) continue; // another request got it first
    slots--;
    runInBackground(runItem(leased, item.id));
  }
}

/** Process one leased item. Never throws: failures are recorded on the item. */
export async function runItem(job, itemId) {
  const item = job.items.find(i => i.id === itemId);
  const startedAt = Date.now();
  const set = patch => updateJobItem(job._id, itemId, patch).catch(err => console.error('[Jobs] update failed:', err.message));
  const fail = error => set({ status: 'failed', stage: 'failed', error, finishedAt: new Date(), elapsedMs: Date.now() - startedAt });
  try {
    await set({ stage: 'downloading', progress: STAGE_PROGRESS.downloading });
    const ref = { path: item.storagePath, driver: item.storageDriver, mimeType: item.mimeType, size: item.size };
    const buffer = await getObject(ref);
    if (!buffer) return await fail('The uploaded file could not be found. Please upload it again.');
    if (buffer.length > maxUploadBytes()) return await fail(`File is too large. Maximum size is ${Math.round(maxUploadBytes() / 1024 / 1024)} MB.`);
    const owner = job.userId ? { _id: job.userId } : job.guestId ? { guestId: job.guestId } : null;
    const result = await processDocument(
      { buffer, originalname: item.filename, mimetype: item.mimeType, size: buffer.length },
      {
        owner,
        deadline: Date.now() + AI_BUDGET_MS,
        fileRef: { ...ref, size: buffer.length },
        quality: item.quality,
        onStage: stage => set({ stage, progress: STAGE_PROGRESS[stage] ?? 50 }),
      },
    );
    if (!result.success) {
      await deleteObject(ref);
      return await fail(result.error);
    }
    await set({
      status: 'done', stage: 'done', progress: 100, documentId: result.id, cached: Boolean(result.cached),
      ...(result.warning ? { warning: result.warning } : {}), finishedAt: new Date(), elapsedMs: Date.now() - startedAt,
    });
    console.log(`[Jobs] ${item.filename}: ${result.docType}${result.cached ? ' (cached)' : ''} in ${Date.now() - startedAt}ms`);
  } catch (err) {
    console.error('[Jobs] item failed:', err);
    await fail('Something went wrong while reading this file. Please try again.');
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
