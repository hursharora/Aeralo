import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { endpoint, isAirCanadaUrl, isSearchResponse, isLoginPage, normalize, pageFailure, redact, summarize } from './core.js';

export function browserOptions({ headed = false, executable } = {}) {
  const launch = { headless: !headed, executablePath: executable, timeout: 15000 };
  const localLibraries = fileURLToPath(new URL('../.browser-libs/usr/lib/x86_64-linux-gnu/', import.meta.url));
  if (process.platform === 'linux' && existsSync(join(localLibraries, 'libasound.so.2'))) {
    launch.env = { ...process.env, LD_LIBRARY_PATH: [localLibraries, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
  }
  return launch;
}

export async function collect({ url, out, timeout = 45, headed = false, executable, profile }, { browserType = chromium } = {}) {
  await mkdir(out, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const captures = [];
  const network = [];
  const pending = new Set();
  const notes = [];
  let failure = null;
  let failureDetails = null;
  let navigation = null;
  let browserVersion = null;
  let context;
  let browser;
  let page;
  let lastSearchAt = null;
  let activeSearches = 0;
  let finalEndpoint = null;
  let timedOut = false;
  const deadline = Date.now() + timeout * 1000;
  try {
    const launch = browserOptions({ headed, executable });
    if (profile) {
      context = await browserType.launchPersistentContext(profile, launch);
    } else {
      browser = await browserType.launch(launch);
      context = await browser.newContext();
    }
    browserVersion = context.browser()?.version() ?? null;
    const fail = (status, details) => {
      if (failure) return;
      failure = status;
      failureDetails = details;
    };
    context.on('response', response => {
      const request = response.request();
      if (!isAirCanadaUrl(response.url())) return;
      const search = isSearchResponse(response.url());
      const mainDocument = request.resourceType() === 'document' && request.frame() === page?.mainFrame();
      const details = { stage: search ? 'search_response' : 'document',
        endpoint: endpoint(response.url()), status: response.status(),
        server: response.headers().server ?? null,
        contentType: response.headers()['content-type'] ?? null };
      if (mainDocument) navigation = details;
      if (network.length < 300 && (search || request.resourceType() === 'document' || ['xhr', 'fetch'].includes(request.resourceType()))) {
        network.push({ endpoint: endpoint(response.url()), status: response.status(), type: request.resourceType() });
      }
      // An unrelated iframe denial must not fail the top-level flight search.
      if (!search && !mainDocument) return;
      if ([401, 403, 429].includes(response.status())) {
        fail(response.status() === 401 ? 'authentication_required' : 'blocked', {
          ...details, reason: response.status() === 401 ? 'http_unauthorized' :
            response.status() === 429 ? 'http_rate_limited' : 'http_forbidden',
        });
      } else if (response.status() >= 400) {
        fail('upstream_error', { ...details, reason: 'http_error' });
      }
      if (!search || captures.length + activeSearches >= 20) return;
      activeSearches++;
      lastSearchAt = Date.now();
      const task = (async () => {
        const observedAt = new Date().toISOString();
        const capture = { observedAt, endpoint: endpoint(response.url()), status: response.status() };
        captures.push(capture);
        try {
          const length = Number(response.headers()['content-length']);
          if (length > 5_000_000) throw new Error('Response exceeds 5 MB capture limit');
          const body = await response.body();
          if (body.length > 5_000_000) throw new Error('Response exceeds 5 MB capture limit');
          capture.body = redact(JSON.parse(body.toString('utf8')));
          if (response.ok()) capture.parsed = normalize(capture.body, { observedAt, source: capture.endpoint });
        } catch (error) {
          capture.error = error instanceof SyntaxError ? 'Search response is not JSON' : 'Unable to capture search response';
        } finally {
          activeSearches--;
          lastSearchAt = Date.now();
        }
      })();
      pending.add(task);
      task.finally(() => pending.delete(task));
    });
    context.on('requestfailed', request => {
      if (!isAirCanadaUrl(request.url())) return;
      const mainDocument = request.resourceType() === 'document' && request.frame() === page?.mainFrame();
      if (!isSearchResponse(request.url()) && !mainDocument) return;
      fail('network_error', { stage: mainDocument ? 'document' : 'search_response',
        endpoint: endpoint(request.url()), reason: 'request_failed',
        networkCode: request.failure()?.errorText?.match(/net::[A-Z_]+/)?.[0] ?? null });
    });
    page = context.pages()[0] ?? await context.newPage();
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame() && isLoginPage(frame.url())) {
        fail('authentication_required', { stage: 'document', endpoint: endpoint(frame.url()), reason: 'login_redirect' });
      }
    });
    page.setDefaultTimeout(1500);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeout * 1000, 30000) });
    } catch {
      notes.push('Navigation did not complete normally; inspect network.json.');
    }
    while (!failure && Date.now() < deadline && !page.isClosed()) {
      if (isLoginPage(page.url())) {
        fail('authentication_required', { stage: 'document', endpoint: endpoint(page.url()), reason: 'login_redirect' });
        break;
      }
      const text = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
      const textFailure = pageFailure(text);
      if (textFailure) fail(textFailure, { stage: 'page', endpoint: endpoint(page.url()), reason: 'page_message' });
      if (failure) break;
      if (lastSearchAt && !activeSearches && Date.now() - lastSearchAt >= 2500) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    timedOut = Date.now() >= deadline;
    finalEndpoint = endpoint(page.url());
    if (page.isClosed()) { failure ??= 'browser_closed'; }
    if (failure === 'blocked' && failureDetails?.stage === 'document') {
      notes.push('The top-level document was denied before the search application could load; no parser or flight-search API failure is established.');
      if (/akamai/i.test(failureDetails.server ?? '')) notes.push('The denial response identifies Akamai. This alone does not distinguish network/IP restrictions from browser/session rules.');
    }
    if (failure === 'authentication_required') notes.push('Sign in manually with npm run scrape -- --login --profile .profiles/aeroplan, then repeat the search with the same --profile.');
  } catch (error) {
    failure = 'browser_error';
    failureDetails = { stage: 'browser', reason: /Executable doesn't exist/.test(error.message)
      ? 'browser_not_installed' : /shared libraries|Host system is missing dependencies/.test(error.message)
        ? 'missing_browser_dependencies' : 'browser_launch_or_runtime_error' };
    notes.push(error.message.split('\n')[0]);
    notes.push('Install Chromium with npm run install-browser. On Linux, use npx playwright install-deps chromium if shared libraries are missing.');
  } finally {
    // Closing also interrupts response reads that never finished; drain them before writing.
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    await Promise.allSettled([...pending]);
  }
  const result = summarize(captures, { failure, timedOut });
  const report = {
    mode: 'live', startedAt, finishedAt: new Date().toISOString(),
    requestedEndpoint: endpoint(url), finalEndpoint, status: result.status,
    browser: { version: browserVersion, headed }, navigation, failureDetails,
    offerCount: result.offers.length, capturedSearchResponses: captures.length,
    completion: 'heuristic: search responses quiet for 2.5 seconds, or timeout/failure',
    notes,
  };
  await Promise.all([
    writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 }),
    writeFile(join(out, 'offers.json'), JSON.stringify(result.offers, null, 2), { mode: 0o600 }),
    writeFile(join(out, 'captures.json'), JSON.stringify(captures, null, 2), { mode: 0o600 }),
    writeFile(join(out, 'network.json'), JSON.stringify(network, null, 2), { mode: 0o600 }),
  ]);
  return report;
}
