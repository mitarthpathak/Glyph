// Browser checks for the F3–F12 features (key checkpoints only).
// Usage: node scripts/verify-features.mjs [outDir] [section ...]
//   Sections run in order; default: all. Expects the web app on :5173 and
//   scripts/mock-api.mjs on :3001 (canned Gemini answers for samples/).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadChromium, watchPage } from './lib/browser.mjs';

const out = process.argv[2] || 'docs/screenshots/features';
const ALL = ['cross', 'classify', 'entities', 'review'];
const sections = process.argv.slice(3).length ? process.argv.slice(3) : ALL;
const WEB = process.env.WEB_URL || 'http://localhost:5173';
mkdirSync(out, { recursive: true });
const manifest = JSON.parse(readFileSync('samples/manifest.json', 'utf8'));
const sample = letter => manifest.find(m => m.file.startsWith(`${letter}-`)).file;
const asUpload = file => ({
  name: file,
  mimeType: file.endsWith('.jpg') ? 'image/jpeg' : file.endsWith('.png') ? 'image/png' : 'application/pdf',
  buffer: readFileSync(`samples/${file}`),
});

const chromium = await loadChromium();
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
let step = 'start';
const problems = watchPage(page, () => `(${step})`);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
};
const shot = async (name, fullPage = false) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage });
};
const nav = label => page.locator('header nav button', { hasText: new RegExp(`^${label}$`) }).click();
const upload = async letters => {
  await nav('Upload');
  await page.getByTestId('file-input').setInputFiles(letters.map(l => asUpload(sample(l))));
  await page.getByTestId('document-screen').waitFor({ timeout: 120_000 });
};
const openDoc = async letter => {
  await page.locator('[data-testid="document-screen"] button[aria-pressed]', { hasText: sample(letter) }).click();
  await page.waitForTimeout(500);
};

process.on('uncaughtException', async err => {
  console.log(`ERROR at step "${step}": ${err.message.split('\n')[0]}`);
  if (problems.length) console.log(problems.join('\n'));
  await page.screenshot({ path: `${out}/error-${step}.png`, fullPage: true }).catch(() => {});
  process.exit(1);
});

// Signed in, so every section works on one account's documents.
await page.goto(WEB);
const signup = await page.request.post(`${WEB}/api/auth/signup`, { data: { email: `features${Date.now()}@example.com`, password: 'secret12', phone: '9876543210', age: 21 } });
await page.evaluate(t => localStorage.setItem('glyph_token', t), (await signup.json()).token);
await page.reload();

if (sections.includes('cross')) {
  step = 'cross';
  await upload(['d', 'i', 'a', 'j']);
  await openDoc('i');
  await page.getByTestId('cross-issues').waitFor({ timeout: 10_000 });
  const text = await page.getByTestId('cross-issues').innerText();
  check('ID card shows the date-of-birth conflict with the marksheet', /Date of birth of Asha Verma differs: "14\/02\/2006" in Statement of Marks.*"14\/03\/2006"/s.test(text), text.split('\n').slice(0, 3).join(' / '));
  check("and the father's name spelt differently", /Father's \/ guardian's name of Asha Verma differs/.test(text));
  const flagged = await page.getByTestId('field-row').filter({ hasText: /Date of birth/i }).innerText();
  check('the conflicting field is flagged in the field list', /check/i.test(flagged));
  await page.getByTestId('cross-issues').scrollIntoViewIfNeeded();
  await shot('f4-cross-document-issues');
  await page.getByTestId('cross-open').first().click();
  await page.getByTestId('source-panel').waitFor({ timeout: 10_000 });
  const badge = await page.getByTestId('doc-type-badge').innerText();
  const panel = await page.getByTestId('source-panel').innerText();
  check('the link opens the marksheet at the conflicting field', /marksheet/i.test(badge) && /Date of birth/i.test(panel), `${badge} / ${panel.split('\n')[1]}`);
  await openDoc('j');
  await page.getByTestId('cross-issues').waitFor({ timeout: 10_000 });
  check('the duplicate invoice number with another total is an error',
    /ERROR\s*Invoice ET\/2024-25\/0147 from Example Traders Pvt Ltd appears in two documents with different totals/i.test(await page.getByTestId('cross-issues').innerText()));
}

if (sections.includes('classify')) {
  step = 'classify';
  if (!sections.includes('cross')) await upload(['i', 'a']);
  await openDoc('a');
  const badge = page.getByTestId('doc-type-badge');
  check('the invoice shows its subtype next to the type', /tax invoice/i.test(await page.getByTestId('doc-subtype-badge').innerText()));
  check('the type badge explains its confidence', /Financial · AI \d+%, keywords \d+%, required fields found \d+%/.test(await badge.getAttribute('title') || ''), await badge.getAttribute('title'));
  await openDoc('i');
  const sub = await page.getByTestId('doc-subtype-badge').innerText();
  const also = await page.getByTestId('type-candidates').innerText().catch(() => '');
  check('the ID card is a student ID with a runner-up type', /student id/i.test(sub) && /Also possible: Marksheet/i.test(also), `${sub} / ${also}`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('f5-classification');
}

if (sections.includes('entities')) {
  step = 'entities';
  if (!sections.includes('cross')) await upload(['d', 'i', 'a', 'j']);
  await nav('Graph');
  await page.getByTestId('graph-mode-entities').click();
  await page.getByTestId('graph-canvas').waitFor({ timeout: 10_000 });
  const labels = await page.getByTestId('graph-node').allInnerTexts();
  check('the graph links Asha Verma, Example Traders and their documents',
    labels.some(l => /Asha Verma\s*Person/i.test(l)) && labels.some(l => /Example Traders.*\s*Organisation/i.test(l)) && labels.some(l => /Statement of Marks/i.test(l)),
    `${labels.length} nodes`);
  const red = await page.locator('[data-testid="mismatch-edge"][data-severity="error"]').count();
  check('conflicting values are joined by red edges', red === 2, `${red} red edges, conflicts: ${await page.getByTestId('graph-conflicts').innerText()}`);
  await shot('f6-entity-graph');
  await page.getByTestId('graph-node').filter({ hasText: /^Date of birth: 14\/03\/2006$/ }).click();
  const dialog = page.getByRole('dialog');
  check('a conflicting field explains the conflict', /Date of birth of Asha Verma differs/.test(await dialog.getByTestId('node-conflicts').innerText()));
  await shot('f6-entity-node');
  await dialog.getByTestId('node-open-document').click();
  await page.getByTestId('source-panel').waitFor({ timeout: 10_000 });
  check('and opens the document at that field', /Date of birth/i.test(await page.getByTestId('source-panel').innerText()));
  await nav('Graph');
  check('the concept-map tab still shows the concept map view', await page.getByTestId('graph-mode-concepts').count() === 1);
}

if (sections.includes('review')) {
  step = 'review';
  if (!sections.includes('cross') && !sections.includes('entities')) await upload(['d', 'i']);
  await nav('Extract');
  await openDoc('i');
  page.on('dialog', d => d.accept());
  const dobRow = page.getByTestId('field-row').filter({ hasText: /Date of birth/i });
  await dobRow.click();
  await page.getByTestId('review-correct').click();
  await page.getByTestId('review-value').fill('14/02/2006');
  await page.getByRole('textbox', { name: 'Note (optional)' }).fill('Checked against the birth certificate');
  await page.getByTestId('review-save').click();
  await page.getByTestId('field-review-status').waitFor({ timeout: 10_000 });
  check('a corrected field is marked and keeps the AI value for reference',
    /Corrected by features.*AI read 14\/03\/2006/s.test(await page.getByTestId('field-review-status').innerText()) && /corrected/i.test(await dobRow.innerText()));
  await page.waitForTimeout(800);
  const cross = await page.getByTestId('cross-issues').innerText().catch(() => '');
  check('the correction settles the date-of-birth conflict with the marksheet', !/Date of birth of Asha Verma differs/.test(cross) && /Father/.test(cross), cross.split('\n')[0]);
  check('the document is in review', /In review · 1\//i.test(await page.getByTestId('review-badge').innerText()));
  await page.getByTestId('field-row').filter({ hasText: /Holder name/i }).click();
  // The previous field's panel animates out first.
  await page.getByTestId('source-panel').filter({ hasText: /Holder name/i }).getByTestId('review-confirm').click();
  await page.getByTestId('field-review-status').waitFor({ timeout: 10_000 });
  await page.getByTestId('review-approve').click();
  await page.getByTestId('review-badge').filter({ hasText: /Approved/i }).waitFor({ timeout: 10_000 });
  const history = await page.getByTestId('audit-entry').allInnerTexts();
  check('the review history lists every action, newest first', history.length === 3 && /Approved the document/.test(history[0]) && /Confirmed Holder name/.test(history[1]) &&
    /Corrected Date of birth: 14\/03\/2006 → 14\/02\/2006/.test(history[2]) && /birth certificate/.test(history[2]), JSON.stringify(history));
  await page.getByTestId('review-history').scrollIntoViewIfNeeded();
  await shot('f7-review-history');
  await dobRow.click();
  await page.getByTestId('source-panel').filter({ hasText: /Date of birth/i }).getByTestId('field-review').scrollIntoViewIfNeeded();
  await shot('f7-field-review');
  await page.getByTestId('review-reset').click();
  await page.getByTestId('review-badge').filter({ hasText: /In review/i }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  check('back to the AI value: the conflict returns and the approval is withdrawn',
    /Date of birth of Asha Verma differs/.test(await page.getByTestId('cross-issues').innerText()) && /approval withdrawn/.test((await page.getByTestId('audit-entry').allInnerTexts())[0]));
}

check('no console errors or failed requests', problems.length === 0, problems.join('\n'));
writeFileSync(`${out}/verify-features.json`, JSON.stringify({ sections, results, problems }, null, 2));
await browser.close();
process.exitCode = results.every(r => r.ok) ? 0 : 1;
