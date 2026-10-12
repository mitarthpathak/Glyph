# Progress: Glyph document intelligence (SKIT024)

Branch: `redesign` (created from `master`). The task is described in [TASK.md](TASK.md).
This session covered **Phases 0–3**. Verification used `npm test`, `npm run lint`, `npm run build`,
API tests (node:test) and a curl check against the running server. Browser testing was skipped on
purpose, apart from the baseline screenshots.

## Done

### Phase 0: recon and setup
- Read the whole codebase. There were no leftover "Run-Neeti" references, so nothing needed renaming.
- `scripts/screens.mjs` captures the existing screens with Playwright: hero, auth, upload (empty and
  with a result), graph, details, quiz and history, on desktop and mobile. It uses the local
  Playwright install or the global one.
  - Usage: `npm start`, then `node scripts/screens.mjs docs/baseline`.
  - **Baseline** screenshots were saved to `docs/baseline/`, which is gitignored and was not
    committed. They were taken before any change on this branch (memory storage, no AI key, so the
    graph is the keyword fallback). Re-run them into `docs/current/` and compare.
- Added `.mcp.json` (Playwright MCP).

### Phase 1: multi-format input
- `server/lib/files.js` validates uploads by **magic bytes**: PDF, PNG, JPEG and WEBP are accepted.
  Each problem gets a clear message:
  - fake files (for example, a `.png` that isn't an image)
  - HEIC/HEIF ("export as JPG or PNG")
  - empty files
  - files over 4 MB (413)
- A multer pre-check rejects obviously unsupported types before buffering.
- `/api/upload` (the concept map) now accepts images as well. They go to Gemini directly, like
  scanned PDFs.
- `UploadZone`:
  - accepts PDF and images, up to 10 files per drop;
  - each file is processed and saved independently, one after another;
  - images over 1.5 MB, or with a long edge over about 3000 px, are downscaled client-side to a
    2000 px long edge as JPEG (quality 0.85, dropping to 0.55 if needed) by `src/lib/image.ts`;
  - image originals up to 40 MB are accepted before compression.
- UI text changes (same elements and classes, no visual redesign):
  - "Upload a PDF" → "Upload a Document"
  - the hint now mentions images
  - chip "PDF Only" → "PDF · Images"
  - "Processing N of M..." for batches

### Phase 2: text layer and OCR path
- `server/lib/pdfText.js`:
  - page-by-page text through the pdf-parse `pagerender` callback;
  - spaces are inserted between table cells, so values don't run together.
- Text-layer classification:
  - **scanned**: fewer than 40 non-space characters per page on average;
  - **mixed**: at least 25% of pages have less than that;
  - **digital**: otherwise.
- Input plan (decision):
  - **digital PDF**: page-tagged text only (`=== PAGE n ===`). Fewest tokens, and the quotes can be
    checked against the text layer in Phase 4.
  - **scanned PDF or image**: the file is sent to Gemini as `inlineData` (OCR and understanding in
    one call), with `ocrUsed: true`.
  - **mixed PDF**: text plus the file, with `ocrUsed: true`.
- Bug fix: pdf.js read Node's whole shared buffer pool for small Buffers, which gave wrong or empty
  text for small PDFs. Buffers are now copied before parsing, in `/api/upload` too.

### Phase 3: classify, extract and summarise in one Gemini call
- `server/lib/schemas.js` defines 8 document types:
  - invoice
  - certificate
  - marksheet
  - application_form
  - report
  - identity_document
  - institutional_record (letter, notice, circular)
  - other (generic key-value)

  Each type has typed fields: `required`, a `format` (pan, gstin, pincode, …), `aliases`, `options`
  for enums, and its typical entities.
- `server/lib/normalize.js`:
  - dates: DD/MM/YYYY read day-first, written dates, Hindi month names and Devanagari digits, all
    to ISO;
  - amounts: ₹, Rs., `/-` and lakh grouping;
  - phone numbers to +91;
  - IDs, enums and lists;
  - format regexes for PAN, GSTIN, PIN code, IFSC, Aadhaar (masked only) and email.
- `server/lib/ai.js` now has a shared `generateStructured()`, also used by the concept map:
  - model chain flash → flash-lite, then once more;
  - exponential backoff (0.5 s, 1 s, 2 s, …) after 429/5xx;
  - each attempt aborted after at most 40 s or at the deadline;
  - JSON repair: code fences, surrounding text, trailing commas, truncated answers;
  - a malformed answer is retried once, then a graceful `BAD_AI_OUTPUT` error.
- `server/lib/extract.js`:
  - `extractDocument()` makes ONE call with `responseMimeType: application/json`, a
    `responseJsonSchema` and temperature 0.
  - The answer has docType, docTypeConfidence, title, language, summary, fields, entities and
    tables, plus `ocrText` for scans (stored for search).
  - `normalizeExtraction()` always lists every predefined field of the detected type. A missing
    field gets value `null`, confidence 0 and no quote. It also keeps up to 15 extra key-values,
    upper-cases and de-duplicates entities, makes tables rectangular, keeps pages within the page
    count, cuts quotes to 120 characters and never returns an empty summary.
  - Rule-based `fallbackExtract()` works on digital PDFs when the AI is unavailable: a keyword
    type guess, "Label: value" matching and regex entities (GSTIN, PAN, ₹ amounts, dates, PIN
    codes, emails, phone numbers). Its confidences are low, it is marked `fallbackUsed`, and it is
    never cached.
- `POST /api/extract`, multipart field `files`:
  - up to 5 files per request, processed in parallel within a 50 s budget;
  - each file saved as its own document;
  - one file failing doesn't fail the others;
  - cached by `sha256(file) + EXTRACTION_VERSION`. A cached document is copied for another user,
    the same way as the existing graph cache.
  - Images and scanned PDFs without the AI return 422 with a clear message.
- Storage: the `Graph` model gained optional fields:
  - `extraction` (including `rawTextByPage`, trimmed for search)
  - `fileHash`
  - `extractionVersion`
  - `mimeType`
  - `fileSize`

  `graph` is now optional. `GET /api/graphs` (History) lists only records that have a graph, so the
  existing History screen is unchanged.
- Auth: `/api/extract` uses the same optional auth as `/api/upload`. Anonymous uploads work; signed-in
  ones are tied to the user.

### Tests
There are now 43 tests (from 9), all passing. They need no database or API key, because Gemini is
replaced with a fake client (`server/test/helpers/fakeGemini.js`, fixture
`test/fixtures/gemini/invoice.json`). Synthetic PDFs and PNGs are generated in
`test/helpers/files.js`.

## Decisions and trade-offs
- **Field name kept:** `/api/upload` still uses the multipart field `pdf` for every file type, for
  backward compatibility.
- **One request per file in the upload screen:** the client will send each file to `/api/extract`
  in its own request, so each request stays under Vercel's 4 MB body limit and 60 s duration. The
  server still accepts up to 5 files in one request ("multi-file aware").
- **Status codes:** unsupported types return 400 (not 415), which the old test and client expect;
  oversized files return 413.
- **Confidence and bboxes deferred:** for now, `confidence` equals the model's confidence
  (`modelConfidence` is stored separately). Phase 4 replaces it with the blended score. Bounding
  boxes were not requested yet.
- **Nullable schema types:** the response schema uses nullable JSON-schema types (`["string","null"]`).
  The normaliser accepts both `null` and empty or "N/A" strings, in case a model ignores them.
- **Extraction stored on the Graph model:** this keeps one collection and one history and is
  backwards-compatible: old records have no `extraction`. The concept map and the extraction can
  later share one record per upload (Phase 6 option).

## Not verified live
- There is **no `GEMINI_API_KEY`** in this environment (`server/.env` does not exist). Nothing was
  checked against the real Gemini service:
  - real classification and extraction quality;
  - whether Gemini accepts the extraction response schema (nullable types, nested arrays);
  - OCR quality on real scans;
  - latency.

  Everything else was checked with the fake client and with the rule-based fallback against the
  running server (curl through the Vite proxy).
- No browser testing beyond the baseline:
  - client-side image compression (`src/lib/image.ts`);
  - multi-file uploads in the UI;
  - the changed upload text.

  These need a Playwright pass next session.

## What is left (Phases 4–10)
1. **Phase 4:** `server/lib/confidence.js`. Blend the model confidence (0.5), source-quote
   verification against `rawTextByPage` (0.3) and validation (0.2). Cap scanned/OCR inputs at
   0.9, use bands high/medium/low, compute the overall document confidence, and unit-test it. Then
   bump `EXTRACTION_VERSION`. Optional: bboxes for images.
2. **Phase 5:** `server/lib/validate.js`. Missing, format, cross-field (invoice math, marksheet
   totals, certificate dates, name consistency, future dates, duplicate IDs) and low-confidence
   issues. Use `normalize.js` helpers and `FORMATS`.
3. **Phase 6:**
   - `GET/DELETE /api/documents`, `GET /api/documents/:id`, `GET /api/documents/:id/export?format=json|csv`;
   - store `issues` and `overallConfidence`;
   - Mongo text index;
   - optional "build concept map from this document".
4. **Phase 7:** `GET /api/search` with a Mongo text index and a ranked in-memory fallback.
5. **Phase 8:** frontend:
   - point UploadZone at `/api/extract`;
   - result view, issues panel, search view;
   - History showing the doc type, confidence and issue count;
   - OCR hint text;
   - keep the concept map reachable.
6. **Phase 9:** synthetic `samples/` and the full Playwright end-to-end pass, with screenshots in
   `docs/screenshots/`.
7. **Phase 10:**
   - README;
   - `.env.example` (no new environment variables so far);
   - a final visual comparison against `docs/baseline/`;
   - push.

Note for the next session: `docs/baseline/` is not in git. If it is missing in a fresh container,
check out `4aa5b15` (before any UI change) and run `node scripts/screens.mjs docs/baseline` to
recreate it.
