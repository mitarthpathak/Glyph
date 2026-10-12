# Glyph

Glyph is an **AI document intelligence platform** for unstructured documents such as forms, certificates,
invoices, marksheets, reports, ID cards and institutional letters or notices.

- Upload PDFs, scans or phone photos. Glyph reads them (with OCR where needed) and identifies the
  document type.
- It extracts the predefined fields and important entities. Every value has a **confidence score** and
  a **source reference** (page and verbatim quote).
- It flags **missing or inconsistent information** and writes a short summary.
- Everything is searchable, in English or Hindi.

Glyph's original feature is still one click away: any document can be turned into an **interactive
knowledge graph** with a study roadmap and a quiz.

Built for the hackathon problem statement **SKIT024: AI-Based Document Intelligence and Information
Extraction System**.

## Features
- **Any input:** PDF, PNG, JPG and WEBP, up to 10 files at a time.
  - Each file is processed and saved independently, as a background job. The browser polls its
    progress stage by stage, so no request stays open during extraction.
  - With Supabase Storage configured, files of up to 50 MB go straight from the browser to storage.
    Without it, each file is sent to the API and limited to 4 MB.
  - Large photos are downscaled in the browser, so an 18 MB photo uploads as under 1 MB.
  - A batch shows its overall progress: files done and failed, percentage and time left.
- **Image quality:** every photo or scan is measured in the browser before upload (sharpness,
  paper brightness, ink contrast, resolution). A blurry, dark or faint image is flagged at once and
  becomes an *Image quality* issue, and values read from it are capped at 75 % confidence.
  - Files are validated by their content (magic bytes). HEIC, fake and oversized files get a clear
    message.
- **OCR when needed:**
  - Digital PDFs use their text layer, page by page.
  - Scanned PDFs, photos and pages with a garbled text layer (common with Hindi fonts) are read by
    Gemini directly. They are marked with an **OCR** badge.
- **Classification:** 8 document types in 6 categories, with about 30 subtypes (tax invoice,
  board marksheet, PAN card, circular …):
  - invoice
  - certificate
  - marksheet / report card
  - application form
  - report
  - identity document
  - letter / notice / record
  - other

  The type confidence is calibrated on the server from the model, keyword evidence in the text and
  how many of the type's required fields were found, so the badge, the top-3 candidates
  ("Also possible: …") and the issues always agree. A close second type is reported.
- **Extraction:**
  - typed, predefined fields per type, plus any other key-values found;
  - entities by type (person, organisation, date, amount, ID, location, email, phone);
  - tables such as line items or subject marks.
  - Indian formats are understood: ₹ amounts with lakh grouping, DD/MM/YYYY dates, PAN, GSTIN, PIN
    code, Hindi month names and Devanagari digits.
- **Confidence and sources:** every value shows a high / medium / low chip. A source panel shows the
  quote with the value highlighted, the page, whether it came from the text layer or OCR, and how the
  score was calculated.
  - It also shows the page itself with the value marked on it. For digital PDFs the position comes
    from the PDF's own text (exact). For scans and photos it is a box Gemini returns in the same
    call (approximate, drawn in a different colour).
- **Validation:** missing required fields, format errors, and cross-field checks such as invoice
  maths, marksheet totals, date order, names spelt differently and duplicated IDs. Issues are grouped
  by severity, and clicking one opens the field.
  - Identity and tax numbers are checked properly, not only by pattern: the Aadhaar Verhoeff
    checksum, the PAN holder-type letter and name initial, and the GSTIN check character. A single
    misread digit or character is caught.
- **Across documents:** the same person or organisation described differently in two of your
  documents is flagged: date of birth, parents' names, gender, name spellings, one ID under two
  names, one GSTIN under two names, and the same invoice number with a different total. Links open
  the other document at the conflicting field.
- **Entity graph:** *Graph → People & documents* links your documents through the people and
  organisations in them, down to their key fields, with a red dashed edge for every conflict.
- **Human review:** confirm, correct or reset any field and approve the document. Every action
  validates the document again and is kept in an append-only audit trail (who, when, from → to,
  note, issues before and after). The Details page of a document's concept map starts with its
  validation and review summary.
- **Privacy:** *Mask personal data* hides names (initials), ID and Aadhaar numbers (last digits),
  dates of birth (year), e-mail, phone, personal addresses and an individual's PAN, everywhere on the
  page, in exports, cross-document messages and the entity graph. Business data stays readable.
- **Hindi:** Hindi values are shown with a transliteration (आशा वर्मा → Asha Varma); documents
  can be translated between Hindi and English (offline transliteration when the AI is down); search
  works across scripts (`suchna` finds सूचना, `examination` finds परीक्षा).
- **Summaries:** 2–4 sentences per document.
- **Ask:** questions about one document or all of them. Answers cite the document, page and a
  verbatim quote, and every quote is checked against its source ("verified"). Without the AI, the
  best-matching passages are quoted instead.
- **Search:**
  - across fields, entities, summaries, validation issues and page text, in English or Hindi;
  - prefix and typo-tolerant;
  - filters for document type, minimum confidence and date;
  - highlighted snippets that open the document at the field's source.
- **Export:** JSON or CSV. The CSV opens in Excel with Hindi intact.
- **Accounts and history:** sign up or log in. Saved documents show their type, confidence and
  issue count, and can be reopened or deleted. Without an account, documents are kept in a guest
  workspace for that browser; signing in moves them into the account.
- **Concept map** (original feature): a knowledge graph, study roadmap and quiz from any document.
- **Caching and fallbacks:**
  - Re-uploading the same file is answered from the cache.
  - If the AI is unavailable, digital PDFs still get a basic rule-based extraction, and scans get a
    clear message.

## How each requirement is met
| # | SKIT024 requirement | Feature | Where |
|---|---|---|---|
| 1 | Accept PDF, image and scanned inputs | Multi-file upload to storage, background jobs; magic-byte validation; client-side image compression | `server/lib/files.js`, `server/lib/storage.js`, `server/lib/jobs.js`, `src/lib/upload.ts`, `src/lib/image.ts` |
| 2 | OCR where required | Text layer per page; scanned, mixed or garbled pages sent to Gemini as the file; OCR badge | `server/lib/pdfText.js`, `server/lib/extract.js` |
| 3 | Identify document types | 8 types with confidence, in one structured Gemini call | `server/lib/schemas.js`, `server/lib/extract.js` |
| 4 | Extract predefined fields and entities | Typed fields per type, extra key-values, entities, tables, normalised values | `server/lib/schemas.js`, `server/lib/normalize.js`, `server/lib/extract.js` |
| 5 | Handle different layouts | Prompt covers multi-column, tables, forms, rotated and noisy scans, handwriting and bilingual text; table cells kept apart in the text layer | `server/lib/extract.js`, `server/lib/pdfText.js`, `samples/` |
| 6 | Detect missing or inconsistent information | Missing, format, checksum, cross-field and low-confidence issues | `server/lib/validate.js`, `server/lib/idchecks.js` |
| 7 | Concise summaries | 2–4 sentence summary, never empty | `server/lib/extract.js` |
| 8 | Search extracted information | `GET /api/search` (MongoDB text index plus ranked in-memory search), and Ask with cited answers | `server/lib/search.js`, `server/lib/ask.js`, `src/components/SearchScreen.tsx`, `src/components/AskPanel.tsx` |
| 9 | Confidence scores and source references | Blended confidence, page and verbatim quote per value, source panel with the value marked on the page | `server/lib/confidence.js`, `src/components/DocumentScreen.tsx`, `src/components/PagePreview.tsx` |

Beyond the brief:
| Feature | Where |
|---|---|
| Checksums for Aadhaar (Verhoeff), PAN and GSTIN; rule catalogue | `server/lib/idchecks.js`, `server/lib/validate.js` |
| Cross-document conflicts | `server/lib/crossdoc.js`, `GET /api/crosscheck` |
| Taxonomy, subtypes, calibrated type confidence and top-3 candidates | `server/lib/classify.js`, `server/lib/schemas.js` |
| Entity graph | `server/lib/entityGraph.js`, `src/components/GraphScreen.tsx` |
| Human review with audit trail | `server/lib/review.js`, `server/routes/review.js`, `src/components/ReviewPanel.tsx` |
| PII masking and redacted exports | `server/lib/redact.js`, `src/App.tsx`, `src/components/DocumentScreen.tsx` |
| Hindi transliteration, translation, cross-language search | `server/lib/translit.js`, `server/lib/translate.js`, `server/lib/search.js` |
| Image-quality warnings, batch progress | `src/lib/quality.ts`, `server/lib/quality.js`, `src/components/UploadZone.tsx` |
| Benchmark against ground truth | `scripts/benchmark.mjs`, `samples/ground-truth.json`, `docs/benchmark/` |
| Validation and review summary on the Details page | `src/components/DocumentCheckSummary.tsx` |

## Pipeline
```
upload: each file to Supabase Storage (signed URL, ≤ 50 MB) or to the API (≤ 4 MB),
        then one job for the batch; the browser polls its progress
  │
  ├─ jobs.js       each file processed in its own background invocation with its own AI budget;
  │                a stalled item is resumed when its lease expires (one retry)
  ├─ files.js      validate by magic bytes (PDF / PNG / JPEG / WEBP; reject HEIC, fakes, oversized)
  ├─ cache         sha256(file) + EXTRACTION_VERSION  ──hit──▶ saved result (instant)
  ├─ pdfText.js    per-page text (pdf-parse); classify each page
  │                  digital  → page-tagged text only               (=== PAGE n ===)
  │                  scanned  → the file itself (OCR)               ocrUsed = true
  │                  mixed or garbled pages → text + the file       ocrUsed = true
  ├─ extract.js    ONE Gemini call (JSON schema, temperature 0):
  │                  type + confidence, fields (value, normalised value, confidence, page,
  │                  verbatim quote, box on the page for scans), entities, tables, summary,
  │                  OCR transcription; large files go through the Gemini Files API
  │                  model fallback flash → flash-lite, backoff on 429/5xx, ≤ 40 s per attempt,
  │                  JSON repair, one retry on malformed output
  │                  (AI unavailable + digital PDF → rule-based fallbackExtract)
  ├─ normalize     every predefined field present (null if absent), dates → ISO, ₹ → numbers …
  ├─ classify.js   category → type → subtype; calibrated type confidence and top-3 candidates
  ├─ validate.js   missing / format / checksum / cross-field issues
  ├─ quality.js    image-quality issues from the browser's measurements (photos and scans)
  ├─ confidence.js per-field score (uses the issues) → low-confidence issues → overall score
  └─ save          MongoDB (in-memory fallback): fields, entities, tables, issues, page text
```

## Confidence score
```
confidence = 0.5 × model confidence
           + 0.3 × verification   (quoteFound × (0.6 + 0.4 × valueInQuote))
           + 0.2 × validation     (1 if the format checks pass; 0 after an error, 0.5 after a warning on the field)
```
- **quoteFound:**
  - 1 if the quote occurs on the cited page; 0.85 if it occurs on another page.
  - A partial score if at least 70 % of its words match and every number in it is on the page.
  - 0 otherwise.
  - The comparison ignores case, punctuation and digit grouping, and handles Devanagari digits.
- **valueInQuote:** whether the value appears in the quote. Amounts, dates and IDs are compared in
  normalised form.
- **Caps:**
  - **0.90** for values read by OCR: scans and photos have no independent text layer to check
    against, only the model's own transcription.
  - **0.40** when neither the quote nor the value occurs anywhere in a document that has a text layer
    (a hallucination).
  - **0.75** for values read by OCR from a blurry, dark or faint image (see Image quality).
  - Missing values score 0.
  - A value a person confirmed or corrected scores 1.0.
- **Type confidence:** p(type) = 0.8 × the model's candidates + 0.2 × keyword evidence in the text,
  then × (0.6 + 0.4 × the share of the type's required fields found).
- **Bands:** high ≥ 0.80, medium 0.50–0.79, low < 0.50.
- **Overall document confidence:** mean of the required fields, minus 0.05 per error and 0.02 per
  warning.

## Validation rules
- **Missing:** a required field of the detected type has no value (error).
- **Format** (warning):
  - GSTIN, including its state code; PAN, PIN code, IFSC;
  - email, phone;
  - unreadable dates, amounts or numbers.
- **Identity and tax numbers** (warning; `server/lib/idchecks.js`):
  - Aadhaar: 12 digits, never starting with 0 or 1, and a valid Verhoeff check digit (16-digit
    Virtual IDs too). A full number is flagged to be masked; messages only ever show the last 4
    digits.
  - PAN: the 4th letter must be a real holder type (P individual, C company, …), and the 5th must
    match the initial of the surname (individuals) or of the name (others). This is checked for
    seller PANs, PAN cards, and the PAN inside each GSTIN.
  - GSTIN: the last character must match the mod-36 check character of the first 14.
- **Invoice:**
  - line items vs subtotal (error);
  - qty × rate vs the line amount;
  - subtotal + tax − discount = total (error);
  - tax total vs CGST + SGST + IGST;
  - CGST = SGST;
  - IGST together with CGST/SGST;
  - non-standard GST rate (info);
  - due date before the invoice date (error);
  - PAN inside the GSTIN vs the PAN shown.
- **Marksheet:**
  - sum of subject marks vs the total (error);
  - maximum marks;
  - marks above the maximum (error);
  - percentage vs total / max (error);
  - PASS/FAIL vs the 33 % pass mark.
- **Dates:**
  - certificate issue date after valid-until (error);
  - ID issue date after expiry (error);
  - notice deadline before the notice date;
  - implausible future dates;
  - a date of birth in the future (error) or over 120 years ago;
  - expired documents (info).
- **General:**
  - the same name or organisation spelt differently (warning);
  - the same number in two different ID fields;
  - an uncertain document type (info).
- **Low confidence:** a required field scored under 0.50 (warning).
- **Image quality** (photos and scans): blurry, too dark or faint (warning); small (info).
- **Across documents** (`GET /api/crosscheck`): a person's date of birth (error when an ID links
  the two documents, warning when only the name does), parents' names, gender and name spellings;
  one ID under two names; one GSTIN under two business names; an invoice number from the same
  seller with two totals (error) or twice with the same total (possible duplicate).

Every rule has a stable id (`invoice.total_mismatch`, `id.aadhaar_checksum`, …): `GET
/api/validation/rules` lists them with severity and description.

## API
All routes are under `/api`. Routes marked 🔒 need `Authorization: Bearer <token>`. Routes marked 👤
work for a signed-in user or for a guest workspace (`X-Guest-Id` header, a random id kept by the
browser), and only ever reach that owner's documents.

| Method and path | Description |
|---|---|
| `GET /health` | Status of the AI and the database |
| `POST /auth/signup`, `POST /auth/login`, `GET /auth/me` 🔒 | Accounts |
| `POST /uploads/sign` 👤 | Where to upload a file: a signed Supabase Storage URL, or `{ mode: 'direct' }` |
| `POST /uploads` 👤 | Direct upload of one file (multipart, 4 MB) when Supabase is not configured |
| `POST /jobs` 👤 | Queue uploaded files (`{ items: [{ path, filename, mimeType, size }] }`, up to 10) for extraction |
| `GET /jobs/:id` 👤 | Per-file progress and results; polling also resumes stalled items |
| `POST /guest/claim` 🔒 | Move this browser's guest documents to the signed-in account |
| `POST /extract` | Synchronous extraction: multipart field `files` (up to 5 files, 4 MB in total), optional `quality` (JSON array of image-quality reports). Returns `{ documents: [...] }`, one result or `{ success: false, error }` per file. |
| `POST /ask` 👤 | `{ question, documentId? }`: answer with citations (`documentId`, `page`, `quote`, `verified`) |
| `GET /documents` 👤 | Saved documents: type, confidence, issue counts, OCR flag |
| `GET /documents/:id` 👤 | Full result: fields, entities, tables, issues, summary, review status and audit trail; `?redact=1` masks personal data |
| `DELETE /documents/:id` 👤 | Delete a document |
| `GET /documents/:id/export?format=json\|csv` 👤 | Download the extraction; `&redact=1` for a redacted export |
| `PATCH /documents/:id/fields/:key` 👤 | `{ action: confirm \| correct \| reset, value?, note? }`: review a field; the document is validated again |
| `POST /documents/:id/review` 👤 | `{ action: approve \| reopen, note? }` |
| `GET /documents/:id/audit` 👤 | The full, append-only review trail |
| `POST /documents/:id/translate` 👤 | `{ to: en \| hi }`: translation of the title, summary, text fields and page text |
| `GET /crosscheck?documentId=` 👤 | Conflicts between the owner's documents (`&redact=1` masked) |
| `GET /entity-graph` 👤 | People, organisations, documents, key fields and conflict edges (`?redact=1` masked) |
| `GET /validation/rules`, `GET /privacy/pii-kinds` | The validation rule catalogue; what masking hides |
| `GET /documents/:id/file`, `GET /documents/:id/file-url` 👤 | The original file (or a short-lived signed URL to it), for the page preview |
| `POST /documents/export?format=json\|csv` | Format a result the client already has (used when signed out); nothing is stored |
| `POST /documents/:id/concept-map` 👤 | Build the knowledge graph, roadmap and quiz from a document |
| `GET /search?q=&type=&minConfidence=&from=&to=` 👤 | Search fields, entities, summaries and page text |
| `POST /upload` | Original concept-map upload (field `pdf`) |
| `GET /graphs` 🔒, `DELETE /graphs/:id` 🔒 | Saved concept maps |

## Tech stack
| Part | Tech |
|---|---|
| Frontend | React 19, Vite, Tailwind CSS 4, Motion, d3-force |
| API | Node.js, Express 5, Multer, pdf-parse |
| AI | Google Gemini (`@google/genai`), default `gemini-flash-latest` with `gemini-flash-lite-latest` as backup |
| Database | MongoDB (Mongoose) with a text index, falling back to in-memory storage |
| Hosting | Vercel services: `app` (Vite frontend) + `server` (Express API) |

## Getting started
Requires Node.js 20 or newer.

```bash
git clone https://github.com/mitarthpathak/Glyph.git
cd Glyph
npm install
npm install --prefix server

cp server/.env.example server/.env   # then fill in GEMINI_API_KEY, MONGO_URI, AUTH_SECRET
npm start                             # web on http://localhost:5173, API on http://localhost:3001
```

### Environment variables (`server/.env`)
| Variable | Required | Notes |
|---|---|---|
| `GEMINI_API_KEY` | yes | From [Google AI Studio](https://aistudio.google.com/apikey). |
| `MONGO_URI` | recommended | Without it, data lives in memory and is lost on restart. URL-encode special characters in the password (`@` becomes `%40`). |
| `AUTH_SECRET` | recommended | Long random string used to sign login tokens. |
| `GEMINI_MODEL` | no | Comma-separated list of models tried in order. |
| `CORS_ORIGIN` | no | Only needed if the frontend is on a different origin. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | no | Store originals in Supabase Storage and upload files of up to 50 MB straight from the browser. The service-role key stays on the server. Without them, originals go to MongoDB (or memory) and uploads are limited to 4 MB. |
| `SUPABASE_BUCKET` | no | Bucket name (default `glyph-documents`), created as a private bucket on first use. |
| `SUPABASE_ANON_KEY` | no | Only if your project requires it on browser uploads. |

Check `http://localhost:3001/api/health` to see whether the AI and the database are connected.

## Limits
- **Upload size:** 50 MB per file with Supabase Storage (the browser uploads straight to storage).
  Without it, 4 MB per file, because of Vercel's request-body limit. Large images are compressed in
  the browser either way.
- **Time:** each file is extracted in its own background invocation with a 48 s AI budget, inside
  Vercel's 60 s function limit; each model attempt is cut off after 40 s. A file whose worker stops
  is picked up again when its 75 s lease expires (one retry).
- **Long documents:** the prompt holds up to 120,000 characters of text, and up to 200 pages are
  read. OCR transcriptions, used for search, cover the first 5 pages.
- **No AI key:** scans and photos cannot be read without Gemini. Digital PDFs fall back to rule-based
  extraction.
- **Boxes on scans are approximate:** for scans and photos, the box on the page preview comes from
  Gemini. Digital PDFs are located exactly in the PDF's text.

## Scripts
| Command | What it does |
|---|---|
| `npm start` | Runs the Vite dev server and the API together |
| `npm run build` | Builds the frontend into `dist/` |
| `npm run lint` | Type-checks the frontend |
| `npm test` | API and unit tests (no database or API key needed). Set `TEST_MONGO_URI` to also test against a real MongoDB. |
| `node scripts/make-samples.mjs` | Regenerates the synthetic sample documents in `samples/` |
| `node scripts/mock-api.mjs` | Local API with canned Gemini answers for the samples (no key needed); `MOCK_AI=off` simulates the AI being down |
| `node scripts/verify-samples.mjs` | Headless browser pass over the samples (screenshots in `docs/screenshots/`) |
| `node scripts/verify-features.mjs [dir] [section …]` | Headless browser checks of the F3–F12 features (cross, classify, entities, review, mask, hindi, quality, details) |
| `npm run benchmark -- --api <url> --label <name>` | Benchmark against `samples/ground-truth.json` (see below); run it against a freshly started API |
| `API_PROXY_TARGET=http://localhost:3002 npx vite --port 5174` | A second dev server in front of another local API (e.g. one with live Gemini next to the mock); browser scripts take `WEB_URL` |
| `node scripts/screens.mjs <dir>` and `node scripts/compare.mjs` | Screenshots of the existing screens, and pixel diff against a baseline |

## Benchmark
`scripts/benchmark.mjs` uploads every sample to a running API, one at a time, and compares the result
with `samples/ground-truth.json`. Reports are in `docs/benchmark/`.

| Measure | Live Gemini (`benchmark-live-gemini.md`) | Mock (`benchmark-mock.md`) |
|---|---|---|
| Document type / subtype accuracy | 100 % / 100 % | 100 % / 100 % |
| Field precision / recall / F1 | 98.3 % / 92.6 % / 95.4 % | 100 % |
| … on the 10 documents the AI answered | 98.1 % / 98.1 % / 98.1 % | – |
| Accuracy of "high" confidence values | 97.9 % (94 values) | 100 % |
| Planted problems found / false alarms | 8 of 9 / 3 | 9 of 9 / 0 |
| Latency p50 (text-layer PDFs / scans and photos) | 6.6 s (5.2 s / 7.0 s) | 0.6 s |

In the live run Gemini's free-tier quota was hit while the first sample was being read; it got the
rule-based extraction after 50 s, which explains the missed fields, the false alarms (its missing
amounts) and the missed invoice conflict. Re-run on its own, the AI answered it in 20 s with 15 of
15 fields right. The mock run uses canned answers equal to the ground truth, so it measures the
pipeline (validation, scoring, cross-checks), not the AI.

## How to demo
The `samples/` documents are synthetic: no real people or organisations.

1. `npm start`, then open http://localhost:5173 and **Sign In → Sign up**.
2. **Upload:** drop the files from `samples/` (up to 10 at once). The batch shows its overall
   progress; each file is processed and appears in the result switcher on the **Extract** screen.
3. **a-invoice-digital.pdf:** an invoice at 98 % with high-confidence fields. Click **Total amount**
   to see the quote, the page, "PDF text layer" and the score breakdown. There are no issues.
4. **b-invoice-total-mismatch.pdf:** the Issues panel shows two errors: *Seller GSTIN is missing*
   and *Total ₹11,710 does not match ₹9,500 + tax ₹1,710 = ₹11,210*. Click the second to jump to
   the field. Then **Export CSV** or **Export JSON**.
5. **c-certificate…pdf:** an error, *Valid until is before the issue date*, and a warning, *Rohan
   Mehta / Rohan Mehtaa*.
6. **d-marksheet…pdf:** *Subject marks add up to 408, but the total shown is 418*.
7. **e-application-form-scan.jpg** and **f-student-id-scanned.pdf:** the **OCR** badge, with every
   value capped at 90 %.
8. **g-notice-bilingual…pdf:** a Hindi + English notice. The Hindi quotes appear in the source panel.
9. **h-report-unusual-layout.pdf:** two columns with a rotated sidebar. Then click **Build Concept
   Map** to get the original graph, and open **Details** for the roadmap and quiz.
10. **Search:** try `परीक्षा`, `GSTIN` with type *Invoice* and *High only*, or a typo such as
    `Rohen`. Click a result to open its source.
11. **Ask:** switch Search to **Ask** and try *Which invoices have a wrong total?* or *When do the
    annual exams begin?*. Each answer cites its document, page and quote; click a citation to open
    it on the page.
12. **History:** each card shows the type, confidence, OCR and issue count; documents can be
    reopened or deleted.
13. **Across documents:** upload **d** and **i** (the same student): the ID card shows *Date of
    birth of Asha Verma differs* and *Father's name differs*; **Open Statement of Marks →** jumps to
    the other document. **j** reuses invoice number ET/2024-25/0147 of **a** with another total.
14. **Graph → People & documents:** Asha Verma and Example Traders with their documents, and red
    dashed edges between the conflicting values.
15. **Review:** on the ID card, select *Date of birth*, **Correct** it and add a note; the conflict
    disappears and the review history records it. **Approve document**; then **Build Concept Map**
    and open **Details**: it starts with the document's check and review summary.
16. **Mask personal data:** names become initials, the roll number and date of birth are masked, and
    **Export JSON** downloads a redacted file.
17. **Hindi:** on **g**, the Hindi values show their transliteration; **Translate to English**;
    then search `suchna pariksha`.
18. **k-application-form-blurry-photo.jpg:** flagged *Blurry photo · Too dark* while uploading, with
    *Image quality* issues and values capped at 75 %.
19. **AI unavailable:** run `MOCK_AI=off node scripts/mock-api.mjs` with `npm run client`.
    Digital PDFs get a "basic extraction" banner, and scans get a clear message.

## Deploying to Vercel
1. Import the repository in Vercel. `vercel.json` defines two services in one project:
   `app` (the Vite frontend, repository root) and `server` (the Express API in `server/`).
   Requests to `/api/*` go to `server` and everything else goes to `app`, so the frontend keeps
   calling relative `/api/...` URLs. Run `vercel dev` to start both services together locally.
2. Under **Settings → Environment Variables**, add `GEMINI_API_KEY`, `MONGO_URI` and `AUTH_SECRET`.
   Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to allow uploads above 4 MB; the bucket is
   created automatically.
3. In MongoDB Atlas, go to **Network Access** and allow `0.0.0.0/0`, because Vercel's IP addresses change.
   The search text index is created automatically.

## Project structure
```
server/
  index.js              Express app (Vercel `server` service): routes, health check, error handling
  lib/files.js          Upload validation (magic bytes, size, HEIC)
  lib/storage.js        Original files: Supabase Storage, MongoDB or memory
  lib/jobs.js           Background extraction jobs (leases, progress, resume)
  lib/processDocument.js One file: validate → cache → extract → score → save
  lib/owner.js          Signed-in user or guest workspace (X-Guest-Id)
  lib/pdfText.js        Per-page PDF text, scanned / mixed / garbled detection
  lib/schemas.js        Document types and their fields
  lib/extract.js        Gemini extraction prompt, schema, normalisation, rule-based fallback
  lib/normalize.js      Dates, ₹ amounts, IDs, formats (PAN, GSTIN, PIN …)
  lib/validate.js       Missing / inconsistent information rules
  lib/idchecks.js       Aadhaar Verhoeff, PAN structure, GSTIN check character
  lib/confidence.js     Confidence scoring and source verification
  lib/pipeline.js       validate → score → overall confidence
  lib/search.js         Search ranking and snippets
  lib/ask.js            Ask: retrieval, one Gemini call, verified citations
  lib/ai.js             Gemini client, model fallback, JSON repair, concept map
  lib/db.js             MongoDB with in-memory fallback
  routes/               auth, jobs, extract, documents, search, ask, upload, graphs
  test/                 node:test unit, API and sample tests
src/
  App.tsx               Screens and app state
  components/           Hero, Upload, Extract (DocumentScreen, PagePreview), Search + Ask (AskPanel),
                        Graph, Details, Quiz, History, Auth
  lib/upload.ts         Upload to storage, start a job, poll its progress
samples/                Synthetic test documents (+ manifest.json)
scripts/                Sample generation, mock API, browser verification
docs/                   Task, progress notes, screenshots
```
