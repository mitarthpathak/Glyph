// Local verification only: runs the real API on :3001 with Gemini replaced by
// canned answers from server/test/fixtures/gemini/*.json, so the whole app can
// be exercised in a browser without an API key.
//   node scripts/mock-api.mjs            (then: npm run client)
//   MOCK_AI=off node scripts/mock-api.mjs   simulates the AI being unavailable
// A fixture is used when its "_match" regex matches the document text (or,
// for scans and photos, the uploaded file name sent in the prompt).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtureDir = path.join(root, 'server/test/fixtures/gemini');
process.env.VERCEL = '1'; // do not auto-listen; we listen below
if (process.env.MOCK_MONGO_URI) process.env.MONGO_URI = process.env.MOCK_MONGO_URI;
else process.env.MONGO_URI = '';
process.env.GEMINI_API_KEY = '';
process.env.AUTH_SECRET ||= 'local-mock-secret';

const { default: app } = await import(path.join(root, 'server/index.js'));
const { setGeminiClient } = await import(path.join(root, 'server/lib/ai.js'));
const { connectDB } = await import(path.join(root, 'server/lib/db.js'));

const fixtures = readdirSync(fixtureDir)
  .filter(f => f.endsWith('.json'))
  .map(f => ({ name: f, json: JSON.parse(readFileSync(path.join(fixtureDir, f), 'utf8')) }));

function pick(parts) {
  const text = parts.filter(p => p.text).map(p => p.text).join('\n');
  const doc = text.includes('DOCUMENT TEXT') ? text.slice(text.indexOf('DOCUMENT TEXT')) : '';
  const fileHint = parts.find(p => p.inlineData) ? (parts.find(p => p.inlineData).inlineData.data.length + '') : '';
  for (const f of fixtures) {
    const m = f.json._match && new RegExp(f.json._match, 'i');
    if (m && (m.test(doc) || (f.json._matchSize && fileHint === String(f.json._matchSize)))) return f;
  }
  return fixtures.find(f => f.name === 'invoice.json');
}

if (process.env.MOCK_AI !== 'off') {
  setGeminiClient({
    models: {
      async generateContent({ contents, model }) {
        const parts = contents[0].parts;
        if (!parts.some(p => /DOCUMENT TEXT|ocrText|document-intelligence/.test(p.text || ''))) {
          // Concept-map prompt: let the caller fall back to the keyword map.
          throw Object.assign(new Error('mock: concept map not mocked'), { status: 403 });
        }
        const f = pick(parts);
        await new Promise(r => setTimeout(r, 600));
        const { _match, _matchSize, ...answer } = f.json;
        console.log(`[mock] ${model} -> ${f.name}`);
        return { text: JSON.stringify(answer), modelVersion: `${model} (mock)` };
      },
    },
  });
}

await connectDB();
const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log(`Mock API on http://localhost:${port} (AI ${process.env.MOCK_AI === 'off' ? 'off' : 'mocked'})`));
