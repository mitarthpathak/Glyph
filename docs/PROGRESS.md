# Progress: Glyph document intelligence (SKIT024)

Branch: `redesign` (created from `master`). The task is described in [TASK.md](TASK.md).
Session 1 covered **Phases 0–3**, session 2 **Phases 4–6** and session 3 **Phases 7–8** (sections below).
In session 1 Verification used `npm test`, `npm run lint`, `npm run build`,
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

## Session 2: Phases 4–6 (unit and API tests only, no browser)

### Phase 4: confidence and source references (`server/lib/confidence.js`)
- Formula: `confidence = 0.5 × model + 0.3 × verification + 0.2 × validation`, clamped to 0–1
  and rounded to 2 decimals.
  - **verification:** `quoteFound × (0.6 + 0.4 × valueInQuote)`.
    - `quoteFound`: 1 when the quote appears on the cited page, 0.85 on another page, a partial
      score when ≥ 70 % of its words match and every number in it is present on the page, else 0.
    - `valueInQuote`: whether the value is inside the quote. Amounts, dates and IDs are compared
      in normalised form ("₹1,18,000" = 118000).
    - The comparison ignores case, punctuation and digit grouping, and handles Devanagari digits.
  - **validation:** 1 when the field's own format checks pass; 0 after an error issue on the field,
    0.5 after a warning, 0.8 after an info.
- **Caps:**
  - OCR values are capped at **0.90**, because they can only be checked against the model's own
    transcription.
  - A value whose quote and value both appear nowhere in a document that has a text layer is
    capped at **0.40** (low). This is how hallucinated quotes are penalised.
  - Missing values score 0.
- **Bands:** high ≥ 0.80, medium 0.50–0.79, low < 0.50.
- Entities are scored the same way, starting from a neutral model confidence of 0.8.
- Each field also carries `confidenceDetail { model, verification, validation, quoteFound,
  source: text_layer|ocr, capped? }`, for the source panel in the UI.
- **Overall document confidence** = mean of the required fields' confidence, minus 0.05 per
  error and 0.02 per warning.
- **Bounding boxes skipped (decision):** they could not be checked for reliability without a live
  key. The page number and quote serve as the source reference.

### Phase 5: missing and inconsistent information (`server/lib/validate.js`)
Pure functions returning `{ severity, type, fieldKeys, message }`, sorted with errors first.
- **missing:** a required field with no value (error).
- **format:**
  - GSTIN (including the state code), PAN, PIN code, email, phone;
  - unreadable dates, amounts or numbers;
  - a full Aadhaar number (should be masked).
- **invoice:**
  - line items vs the subtotal (error);
  - qty × rate vs the line amount;
  - subtotal + tax − discount = total (error);
  - tax total vs CGST + SGST + IGST;
  - CGST = SGST;
  - IGST charged together with CGST/SGST;
  - non-standard GST rate (info);
  - due date before the invoice date (error);
  - the PAN inside the GSTIN vs the PAN shown.
- **marksheet:**
  - sum of subject marks vs the total (error);
  - sum of maximum marks vs the maximum total;
  - marks obtained above the maximum;
  - percentage vs total/max (error);
  - PASS/FAIL vs the 33 % pass mark.
- **dates:**
  - certificate issue date ≤ valid-until (error);
  - ID issue date ≤ expiry;
  - notice date ≤ deadline;
  - date of birth before the issue date;
  - implausible future dates;
  - a date of birth in the future (error) or over 120 years ago;
  - expired documents (info).
- **general:**
  - the same name or organisation written differently (same word count, ≥ 80 % similar);
  - the same number used for two different ID fields;
  - an uncertain document type (info).
- **low_confidence:** a required field scored under 0.5 (warning).
- **Pipeline** (`server/lib/pipeline.js`): validate → score using the issues → add low-confidence
  issues → overall confidence. `EXTRACTION_VERSION` is now 3, so older cached extractions are
  recomputed.

### Phase 6: persistence and API
- Records (on the existing Graph model) now also store:
  - `issues`, `overallConfidence` and the scored fields, inside `extraction`;
  - `graphFallback`.
- The model is backwards-compatible: old records without `extraction` are untouched, and
  `/api/graphs` and `/api/upload` are unchanged.
- **Routes** (all require sign-in and only reach the user's own documents):
  - `GET /api/documents`: short list with type, overall confidence, issue counts, OCR flag and
    `hasGraph`.
  - `GET /api/documents/:id`: everything except the stored page text.
  - `DELETE /api/documents/:id`.
  - `GET /api/documents/:id/export?format=json|csv`. The CSV has one row per field, entity, issue
    and table row, starts with a UTF-8 BOM so Hindi shows correctly in Excel, and neutralises
    spreadsheet formulas.
  - `POST /api/documents/:id/concept-map`: builds the existing concept map, roadmap and quiz from
    the stored page text and saves it on the same record, which then appears in History. Without
    the AI it falls back to the keyword map.
- `POST /api/extract` keeps the same optional sign-in as `/api/upload` (decision): anonymous users
  can try it, and signed-in uploads are saved to their account.
- **Tests:** 71, all passing:
  - `confidence.test.js`
  - `validate.test.js`: synthetic documents with planted errors, built in `test/helpers/docs.js`
  - `documents.api.test.js`: access control, export, concept map
  - extended `extract.api.test.js`

## Session 3: Phases 7–8

**Browser testing tool:** the Playwright MCP was not available in this session; ToolSearch found
no Playwright tools. As TASK.md allows, verification used headless Playwright scripts in Node
(the global `playwright` with Chromium from `/opt/pw-browsers`). Claude in Chrome was not used.

**MongoDB:** a real MongoDB 7 was started locally in Docker (`mirror.gcr.io/library/mongo:7`;
Docker Hub was rate-limited), so the MongoDB backend is tested as well as the in-memory store.

### Phase 7: search
- `GET /api/search?q=&type=&minConfidence=&from=&to=`, signed-in only, over the user's documents.
- **Matching** (`server/lib/search.js`):
  - Words are compared case-insensitively. Hindi (Devanagari) and English both work, and
    Devanagari digits match ASCII digits.
  - A word scores 1.0 for an exact match, 0.7 for a prefix match and 0.5 for a fuzzy match
    (1 typo, 2 for long words; swapped adjacent letters count as one typo).
- **Ranking:** matches count more in some places than others: field value 3, title or filename 2.5,
  entity 2, summary 1.5, page text 1. There is a bonus when the whole phrase matches, and at most
  3 hits are shown per document.
- **Hits** carry the document id, title and type, the matched field's label and value, a snippet
  with highlight ranges, the page and the confidence.
- **Filters:**
  - `type`;
  - `minConfidence`, checked against each hit's own confidence;
  - `from`/`to`, the upload date, inclusive.

  With an empty query, the documents that pass the filters are listed.
- **MongoDB:** a text index `document_search` covers filename, title, summary, field values,
  entity values and page text. It uses `default_language: 'none'`, so Hindi is not stemmed, and
  `language_override: 'textSearchLanguage'`, because documents have a `language` field of their
  own. The index narrows the candidates first; when it finds nothing (a prefix or a typo), the
  user's recent documents are ranked in memory instead.
- **Tests:** ranker unit tests, plus one API suite that runs on the in-memory store and, when
  `TEST_MONGO_URI` is set, on a real MongoDB (8/8 passing against mongo:7).
  - Without MongoDB the Mongo test is skipped.
  - To run it:
    `docker run -d -p 27017:27017 mongo:7; TEST_MONGO_URI=mongodb://localhost:27017/glyph_test npm test`.

### Phase 8: frontend
All new views reuse existing classes and tokens: cards, pills, chips, the input style from the
auth modal, the amber banner, and the history card layout.
- **Extract screen** (`src/components/DocumentScreen.tsx`, nav item "Extract"):
  - badges: document type with its confidence, OCR, page count, language, and "Basic extraction"
    when the AI was unavailable;
  - an overall-confidence card and a summary card;
  - fields list:
    - each row shows the label, value, a confidence chip (high = tertiary, medium = amber,
      low = red, all from the existing palette) and the page;
    - required fields are marked with `*`, and rows with an issue show a "Check" flag;
    - empty optional fields are hidden behind "Show all fields";
  - **source panel**:
    - the verbatim quote with the value highlighted, the page, and whether it came from the PDF
      text layer or OCR;
    - the confidence breakdown (AI certainty × 50 %, quote found × 30 %, checks × 20 %);
    - a note when the OCR or unverified cap applies;
  - tables, and entities grouped by type;
  - **issues panel** grouped by missing / inconsistent / format / low confidence, with severity.
    Clicking an issue opens its field.
  - Export JSON and Export CSV; Build or Open Concept Map;
  - a switcher for the documents of a multi-file upload.
- **Search screen** (`SearchScreen.tsx`):
  - debounced (300 ms), with document-type and confidence filters;
  - highlighted snippets, and a hit opens the document with that field's source panel.
  - Reachable from the top nav ("Search", when signed in) and from a Search pill in History.
    It is not in the mobile bottom nav: the signed-in bottom nav now has 6 items and fits at
    360 px, and a 7th would not.
- **History:** an "Extracted Documents" section (type, confidence chip, OCR, issue count with
  severity colour, field count, reopen, delete) above the unchanged concept-map cards. It appears
  only when the user has documents; otherwise History is exactly as before.
- **Upload:**
  - every file goes to `/api/extract` in its own request, and the result opens on the Extract
    screen;
  - with partial failures it stays on Upload so the errors can be read, and the new "Open
    Results" pill leads to the results;
  - the description and hint now mention scans and photos (OCR).
- **Concept map:** "Build Concept Map" calls `POST /api/documents/:id/concept-map` when signed in.
  When signed out it re-sends the original file to the legacy `/api/upload`. Graph, Details,
  Roadmap and Quiz are unchanged. Deleting a map built from a document keeps the document.
- **Signed-out export:** `POST /api/documents/export` formats the result already on screen;
  nothing is stored.
- **Accessibility:** field rows, issues, cards and search hits are buttons or `role="button"` with
  aria labels and keyboard support; `aria-pressed` on toggles; `aria-live` on the source panel
  and on results.

### Verification (headless Playwright)
- `node scripts/verify-ui.mjs <outDir> <files...>` against `node scripts/mock-api.mjs` (the real
  API with canned Gemini answers) passes all 24 checks:
  - result view and source panel;
  - keyboard use;
  - export signed out and signed in;
  - no horizontal scroll and the bottom nav fitting on mobile;
  - multi-file upload;
  - history cards, delete and reopen;
  - search, filters and the deep link;
  - concept map → details → quiz;
  - no console errors or failed requests.
- **Visual regression:** `node scripts/screens.mjs docs/current && node scripts/compare.mjs
  docs/baseline docs/current`. The top bar is excluded because it gained the new nav entries.
  - The existing screen components (Hero, Graph, Details, Quiz, Auth) and `index.css` are
    byte-identical to `master`.
  - Remaining pixel differences are, in order of size:
    - the extra bottom-nav item (Extract);
    - entrance and gradient animation timing;
    - the existing random order of Related Modules on Details;
    - the intended additions on Upload (text and the "Open Results" pill) and History (the
      documents section).

## What is left (Phases 9–10)
Phases 4–6 are done (see above). Still to do:
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
