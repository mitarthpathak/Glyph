// Playwright is not a project dependency: use a local install, else the global one.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

export async function loadChromium() {
  try {
    return (await import('playwright')).chromium;
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    return createRequire(`${globalRoot}/`)('playwright').chromium;
  }
}

/** Collects console errors, page errors and failed requests of a page. */
export function watchPage(page, label = () => '') {
  const problems = [];
  page.on('console', m => m.type() === 'error' && problems.push(`[console] ${label()} ${m.text()}`));
  page.on('pageerror', e => problems.push(`[pageerror] ${label()} ${e.message}`));
  page.on('requestfailed', r => {
    const url = r.url();
    // Fonts are optional (offline sandboxes block Google Fonts).
    if (!/fonts\.(googleapis|gstatic)\.com/.test(url)) problems.push(`[requestfailed] ${label()} ${url} ${r.failure()?.errorText}`);
  });
  page.on('response', r => {
    if (r.status() >= 500) problems.push(`[http ${r.status()}] ${label()} ${r.url()}`);
  });
  return problems;
}
