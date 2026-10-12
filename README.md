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
  - Each file is processed and saved independently.
  - Large photos are downscaled in the browser, so an 18 MB photo uploads as under 1 MB.
  - Files are validated by their content (magic bytes). HEIC, fake and oversized files get a clear
    message.
- **OCR when needed:**
  - Digital PDFs use their text layer, page by page.
  - Scanned PDFs, photos and pages with a garbled text layer (common with Hindi fonts) are read by
    Gemini directly. They are marked with an **OCR** badge.
- **Classification:** 8 document types, each with a type confidence:
  - invoice
  - certificate
  - marksheet / report card
  - application form
  - report
  - identity document
  - letter / notice / record
  - other
- **Extraction:**
  - typed, predefined fields per type, plus any other key-values found;
  - entities by type (person, organisation, date, amount, ID, location, email, phone);
  - tables such as line items or subject marks.
  - Indian formats are understood: ₹ amounts with lakh grouping, DD/MM/YYYY dates, PAN, GSTIN, PIN
    code, Hindi month names and Devanagari digits.
- **Confidence and sources:** every value shows a high / medium / low chip. A source panel shows the
  quote with the value highlighted, the page, whether it came from the text layer or OCR, and how the
  score was calculated.
- **Validation:** missing required fields, format errors, and cross-field checks such as invoice
  maths, marksheet totals, date order, names spelt differently and duplicated IDs. Issues are grouped
  by severity, and clicking one opens the field.
- **Summaries:** 2–4 sentences per document.
- **Search:**
  - across fields, entities, summaries and page text, in English or Hindi;
  - prefix and typo-tolerant;
  - filters for document type, minimum confidence and date;
  - highlighted snippets that open the document at the field's source.
- **Export:** JSON or CSV. The CSV opens in Excel with Hindi intact.
- **Accounts and history:** sign up or log in. Saved documents show their type, confidence and
  issue count, and can be reopened or deleted.
- **Concept map** (original feature): a knowledge graph, study roadmap and quiz from any document.
- **Caching and fallbacks:**
  - Re-uploading the same file is answered from the cache.
  - If the AI is unavailable, digital PDFs still get a basic rule-based extraction, and scans get a
    clear message.

## How each requirement is met
| # | SKIT024 requirement | Feature | Where |
|---|---|---|---|
| 1 | Accept PDF, image and scanned inputs | Multi-file upload; magic-byte validation; client-side image compression | `server/lib/files.js`, `src/components/UploadZone.tsx`, `src/lib/image.ts` |
| 2 | OCR where required | Text layer per page; scanned, mixed or garbled pages sent to Gemini as the file; OCR badge | `server/lib/pdfText.js`, `server/lib/extract.js` |
| 3 | Identify document types | 8 types with confidence, in one structured Gemini call | `server/lib/schemas.js`, `server/lib/extract.js` |
| 4 | Extract predefined fields and entities | Typed fields per type, extra key-values, entities, tables, normalised values | `server/lib/schemas.js`, `server/lib/normalize.js`, `server/lib/extract.js` |
| 5 | Handle different layouts | Prompt covers multi-column, tables, forms, rotated and noisy scans, handwriting and bilingual text; table cells kept apart in the text layer | `server/lib/extract.js`, `server/lib/pdfText.js`, `samples/` |
| 6 | Detect missing or inconsistent information | Missing, format, cross-field and low-confidence issues | `server/lib/validate.js` |
| 7 | Concise summaries | 2–4 sentence summary, never empty | `server/lib/extract.js` |
| 8 | Search extracted information | `GET /api/search` (MongoDB text index plus ranked in-memory search) and the Search screen | `server/lib/search.js`, `src/components/SearchScreen.tsx` |
| 9 | Confidence scores and source references | Blended confidence, page and verbatim quote per value, source panel | `server/lib/confidence.js`, `src/components/DocumentScreen.tsx` |

## Pipeline
```
upload (one request per file; at most 4 MB, so large photos are compressed in the browser)
  │
  ├─ files.js      validate by magic bytes (PDF / PNG / JPEG / WEBP; reject HEIC, fakes, > 4 MB)
  ├─ cache         sha256(file) + EXTRACTION_VERSION  ──hit──▶ saved result (instant)
  ├─ pdfText.js    per-page text (pdf-parse); classify each page
  │                  digital  → page-tagged text only               (=== PAGE n ===)
  │                  scanned  → the file itself (OCR)               ocrUsed = true
  │                  mixed or garbled pages → text + the file       ocrUsed = true
  ├─ extract.js    ONE Gemini call (JSON schema, temperature 0):
  │                  type + confidence, fields (value, normalised value, confidence, page,
  │                  verbatim quote), entities, tables, summary, OCR transcription
  │                  model fallback flash → flash-lite, backoff on 429/5xx, ≤ 40 s per attempt,
  │                  JSON repair, one retry on malformed output
  │                  (AI unavailable + digital PDF → rule-based fallbackExtract)
  ├─ normalize     every predefined field present (null if absent), dates → ISO, ₹ → numbers …
  ├─ validate.js   missing / format / cross-field issues
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
  - Missing values score 0.
- **Bands:** high ≥ 0.80, medium 0.50–0.79, low < 0.50.
- **Overall document confidence:** mean of the required fields, minus 0.05 per error and 0.02 per
  warning.

## Validation rules
- **Missing:** a required field of the detected type has no value (error).
- **Format** (warning):
  - GSTIN, including its state code;
  - PAN, PIN code, IFSC;
  - email, phone;
  - unreadable dates, amounts or numbers;
  - an unmasked Aadhaar number.
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

## API
All routes are under `/api`. Routes marked 🔒 need `Authorization: Bearer <token>`.

| Method and path | Description |
|---|---|
| `GET /health` | Status of the AI and the database |
| `POST /auth/signup`, `POST /auth/login`, `GET /auth/me` 🔒 | Accounts |
| `POST /extract` | Multipart field `files` (up to 5 files, 4 MB in total). Returns `{ documents: [...] }`, one result or `{ success: false, error }` per file. Signed-in uploads are saved to the account. |
| `GET /documents` 🔒 | Saved documents: type, confidence, issue counts, OCR flag |
| `GET /documents/:id` 🔒 | Full result: fields, entities, tables, issues, summary |
| `DELETE /documents/:id` 🔒 | Delete a document |
| `GET /documents/:id/export?format=json\|csv` 🔒 | Download the extraction |
| `POST /documents/export?format=json\|csv` | Format a result the client already has (used when signed out); nothing is stored |
| `POST /documents/:id/concept-map` 🔒 | Build the knowledge graph, roadmap and quiz from a document |
| `GET /search?q=&type=&minConfidence=&from=&to=` 🔒 | Search fields, entities, summaries and page text |
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

Check `http://localhost:3001/api/health` to see whether the AI and the database are connected.

## Limits
- **Upload size:** 4 MB per request (Vercel's body limit). The browser sends one file per request
  and compresses large images.
- **Time:** one extraction is a single Gemini call within a 50 s budget, inside Vercel's 60 s
  function limit. Each model attempt is cut off after 40 s.
- **Long documents:** the prompt holds up to 120,000 characters of text, and up to 200 pages are
  read. OCR transcriptions, used for search, cover the first 5 pages.
- **No AI key:** scans and photos cannot be read without Gemini. Digital PDFs fall back to rule-based
  extraction.
- **No bounding boxes:** the source reference is the page plus a verbatim quote.

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
| `node scripts/screens.mjs <dir>` and `node scripts/compare.mjs` | Screenshots of the existing screens, and pixel diff against a baseline |

## How to demo
The `samples/` documents are synthetic: no real people or organisations.

1. `npm start`, then open http://localhost:5173 and **Sign In → Sign up**.
2. **Upload:** drop all eight files from `samples/` at once. Each one is processed and appears in
   the result switcher on the **Extract** screen.
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
11. **History:** each card shows the type, confidence, OCR and issue count; documents can be
    reopened or deleted.
12. **AI unavailable:** run `MOCK_AI=off node scripts/mock-api.mjs` with `npm run client`.
    Digital PDFs get a "basic extraction" banner, and scans get a clear message.

## Deploying to Vercel
1. Import the repository in Vercel. `vercel.json` defines two services in one project:
   `app` (the Vite frontend, repository root) and `server` (the Express API in `server/`).
   Requests to `/api/*` go to `server` and everything else goes to `app`, so the frontend keeps
   calling relative `/api/...` URLs. Run `vercel dev` to start both services together locally.
2. Under **Settings → Environment Variables**, add `GEMINI_API_KEY`, `MONGO_URI` and `AUTH_SECRET`.
3. In MongoDB Atlas, go to **Network Access** and allow `0.0.0.0/0`, because Vercel's IP addresses change.
   The search text index is created automatically.

## Project structure
```
server/
  index.js              Express app (Vercel `server` service): routes, health check, error handling
  lib/files.js          Upload validation (magic bytes, size, HEIC)
  lib/pdfText.js        Per-page PDF text, scanned / mixed / garbled detection
  lib/schemas.js        Document types and their fields
  lib/extract.js        Gemini extraction prompt, schema, normalisation, rule-based fallback
  lib/normalize.js      Dates, ₹ amounts, IDs, formats (PAN, GSTIN, PIN …)
  lib/validate.js       Missing / inconsistent information rules
  lib/confidence.js     Confidence scoring and source verification
  lib/pipeline.js       validate → score → overall confidence
  lib/search.js         Search ranking and snippets
  lib/ai.js             Gemini client, model fallback, JSON repair, concept map
  lib/db.js             MongoDB with in-memory fallback
  routes/               auth, extract, documents, search, upload, graphs
  test/                 node:test unit, API and sample tests
src/
  App.tsx               Screens and app state
  components/           Hero, Upload, Extract (DocumentScreen), Search, Graph, Details, Quiz, History, Auth
samples/                Synthetic test documents (+ manifest.json)
scripts/                Sample generation, mock API, browser verification
docs/                   Task, progress notes, screenshots
```
