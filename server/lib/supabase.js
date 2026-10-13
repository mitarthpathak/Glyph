/** Server-only Supabase Storage service client. Never return its credentials. */
export const supabaseConfig = () => ({
  url: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
  key: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  anonKey: process.env.SUPABASE_ANON_KEY || '',
  bucket: process.env.SUPABASE_BUCKET || 'documents',
});

export const supabaseConfigured = () => Boolean(supabaseConfig().url && supabaseConfig().key);

export async function storageRequest(method, path, { body, headers = {}, raw = false } = {}) {
  const { url, key } = supabaseConfig();
  if (!url || !key) throw new Error('Supabase Storage is not configured');
  const json = body && !Buffer.isBuffer(body) && !(body instanceof Uint8Array);
  const res = await fetch(`${url}/storage/v1${path}`, {
    method,
    signal: AbortSignal.timeout(10_000),
    headers: {
      apikey: key,
      // New secret keys are not JWTs. Legacy service-role JWTs need Bearer auth.
      ...(!key.startsWith('sb_secret_') ? { Authorization: `Bearer ${key}` } : {}),
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(body) : body,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(`Supabase Storage request failed (${res.status})`), { status: res.status, body });
  }
  if (raw) return Buffer.from(await res.arrayBuffer());
  return (res.headers.get('content-type') || '').includes('json') ? res.json() : res.text();
}
