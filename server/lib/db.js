import crypto from 'crypto';
import mongoose from 'mongoose';
import GraphModel from '../models/Graph.js';
import UserModel from '../models/User.js';

// Fail fast instead of silently buffering queries for 10s when the
// database is unreachable; callers fall back to the in-memory store.
mongoose.set('bufferCommands', false);

let connectPromise = null;
let lastError = null;
let lastFailAt = 0;
const RETRY_AFTER_MS = 30_000;

/**
 * Connect once and reuse the connection (also across warm serverless
 * invocations). Resolves to true when MongoDB is usable.
 */
export async function connectDB() {
  if (!process.env.MONGO_URI) return false;
  if (mongoose.connection.readyState === 1) return true;
  // After a failure, don't make every request wait for another attempt.
  if (!connectPromise && Date.now() - lastFailAt < RETRY_AFTER_MS) return false;
  if (!connectPromise) {
    connectPromise = mongoose
      .connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
      .then(() => {
        lastError = null;
        console.log('[DB] MongoDB connected');
        return true;
      })
      .catch(err => {
        lastError = err.message;
        lastFailAt = Date.now();
        console.error('[DB] MongoDB connection failed, using in-memory storage:', err.message);
        connectPromise = null; // allow a retry on a later request
        return false;
      });
  }
  return connectPromise;
}

export function dbStatus() {
  if (!process.env.MONGO_URI) return 'not-configured';
  return mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
}
export const dbLastError = () => lastError;

const useMongo = () => mongoose.connection.readyState === 1;

// ─── In-memory fallback (data is lost on restart) ───────────────────
const memGraphs = [];
const memUsers = [];
const newId = () => crypto.randomBytes(12).toString('hex');
const clone = v => JSON.parse(JSON.stringify(v));

// ─── Users ──────────────────────────────────────────────────────────
export async function findUserByEmail(email) {
  if (useMongo()) return UserModel.findOne({ email }).lean();
  return memUsers.find(u => u.email === email) || null;
}

export async function findUserById(id) {
  if (useMongo()) {
    if (!mongoose.isValidObjectId(id)) return null;
    return UserModel.findById(id).lean();
  }
  return memUsers.find(u => String(u._id) === String(id)) || null;
}

export async function createUser(data) {
  if (useMongo()) return (await UserModel.create(data)).toObject();
  const user = { _id: newId(), createdAt: new Date(), ...data };
  memUsers.push(user);
  return user;
}

// ─── Graphs ─────────────────────────────────────────────────────────
export async function findAiGraphByHash(contentHash) {
  if (useMongo()) return GraphModel.findOne({ contentHash, source: 'ai' }).sort({ createdAt: -1 }).lean();
  return [...memGraphs].reverse().find(g => g.contentHash === contentHash && g.source === 'ai') || null;
}

export async function findUserGraphByHash(contentHash, userId) {
  if (useMongo()) return GraphModel.findOne({ contentHash, userId, source: 'ai' }).lean();
  return memGraphs.find(g => g.contentHash === contentHash && String(g.userId) === String(userId) && g.source === 'ai') || null;
}

// ─── Document extractions (cached by file hash + extraction version) ─
export async function findExtractionByHash(fileHash, version) {
  const match = g => g.fileHash === fileHash && g.extractionVersion === version && g.source === 'ai' && g.extraction;
  if (useMongo()) {
    return GraphModel.findOne({ fileHash, extractionVersion: version, source: 'ai', extraction: { $ne: null } }).sort({ createdAt: -1 }).lean();
  }
  return [...memGraphs].reverse().find(match) || null;
}

export async function findUserExtractionByHash(fileHash, version, userId) {
  if (useMongo()) {
    return GraphModel.findOne({ fileHash, extractionVersion: version, userId, source: 'ai', extraction: { $ne: null } }).lean();
  }
  return memGraphs.find(g => g.fileHash === fileHash && g.extractionVersion === version && g.source === 'ai' &&
    g.extraction && String(g.userId) === String(userId)) || null;
}

export async function saveGraph(doc) {
  if (useMongo()) return (await GraphModel.create(doc)).toObject();
  const saved = { _id: newId(), createdAt: new Date(), ...clone(doc) };
  memGraphs.push(saved);
  return saved;
}

/** Graphs owned by a user (legacy records were keyed by e-mail only). */
function ownerFilter(user) {
  return { $or: [{ userId: user._id }, { userId: null, userEmail: user.email }] };
}
const memOwned = (g, user) =>
  String(g.userId) === String(user._id) || (!g.userId && g.userEmail && g.userEmail === user.email);

/** Saved concept maps (extraction-only documents have no graph). */
export async function listGraphs(user, limit = 50) {
  if (useMongo()) {
    return GraphModel.find({ $and: [ownerFilter(user), { graph: { $ne: null } }] }).sort({ createdAt: -1 }).limit(limit).lean();
  }
  return memGraphs.filter(g => g.graph && memOwned(g, user)).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

// ─── Documents (records with an extraction) ─────────────────────────
const hasExtraction = { extraction: { $ne: null } };

export async function listDocuments(user, limit = 100) {
  if (useMongo()) {
    return GraphModel.find({ $and: [ownerFilter(user), hasExtraction] })
      .select('-extraction.rawTextByPage')
      .sort({ createdAt: -1 }).limit(limit).lean();
  }
  return memGraphs.filter(g => g.extraction && memOwned(g, user)).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export async function getDocument(id, user) {
  if (useMongo()) {
    if (!mongoose.isValidObjectId(id)) return null;
    return GraphModel.findOne({ $and: [{ _id: id }, ownerFilter(user), hasExtraction] }).lean();
  }
  return memGraphs.find(g => String(g._id) === String(id) && g.extraction && memOwned(g, user)) || null;
}

/** Set fields on a record the user owns; returns the updated record or null. */
export async function updateDocument(id, user, patch) {
  if (useMongo()) {
    if (!mongoose.isValidObjectId(id)) return null;
    return GraphModel.findOneAndUpdate({ $and: [{ _id: id }, ownerFilter(user)] }, { $set: patch }, { returnDocument: 'after' }).lean();
  }
  const doc = memGraphs.find(g => String(g._id) === String(id) && memOwned(g, user));
  if (!doc) return null;
  Object.assign(doc, clone(patch));
  return doc;
}

export async function deleteGraph(id, user) {
  if (useMongo()) {
    if (!mongoose.isValidObjectId(id)) return false;
    const res = await GraphModel.deleteOne({ _id: id, ...ownerFilter(user) });
    return res.deletedCount > 0;
  }
  const idx = memGraphs.findIndex(g => String(g._id) === String(id) && memOwned(g, user));
  if (idx === -1) return false;
  memGraphs.splice(idx, 1);
  return true;
}
