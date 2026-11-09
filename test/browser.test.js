import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { collect } from '../src/collect.js';

// Every URL is fulfilled locally: no airline traffic.
test('browser capture writes redacted offers and reports access denials', {
  skip: !process.env.AEROPLAN_BROWSER_TESTS,
}, async () => {
  const payload = JSON.parse(await readFile(new URL('./fixtures/graphql.json', import.meta.url), 'utf8'));
  for (const scenario of ['success', 'blocked', 'schema_unrecognized', 'iframe_denied', 'document_error', 'api_denied', 'network_failed', 'login_redirect']) {
    const out = await mkdtemp(join(tmpdir(), 'aeroplan-browser-'));
    const browserType = {
      async launch(options) {
        const browser = await chromium.launch(options);
        const newContext = browser.newContext.bind(browser);
        browser.newContext = async () => {
          const context = await newContext();
          await context.setOffline(true);
          await context.route('**/*', async route => {
            const path = new URL(route.request().url()).pathname;
            if (scenario === 'network_failed') { await route.abort('connectionrefused'); return; }
            if (scenario === 'login_redirect') {
              await route.fulfill(path === '/fixture' ? { status: 200, contentType: 'text/html', body: '<html><body><script>location.href="/clogin/pages/login";</script></body></html>' }
                : { status: 200, contentType: 'text/html', body: '<html><body>Welcome to Aeroplan</body></html>' });
              return;
            }
            if (path === '/irrelevant-frame') {
              await route.fulfill({ status: 403, contentType: 'text/html', body: '<p>Access denied</p>' });
            } else if (path === '/appsync/lfs') {
              await route.fulfill({ status: scenario === 'api_denied' ? 403 : 200, contentType: 'application/json',
                body: JSON.stringify(scenario === 'schema_unrecognized' ? { changedSchema: true } : payload) });
            } else {
              await route.fulfill({ status: scenario === 'blocked' ? 403 : scenario === 'document_error' ? 503 : 200,
                headers: { server: 'AkamaiGHost' },
                contentType: 'text/html', body: scenario === 'blocked'
                  ? '<html><body>Access denied</body></html>'
                  : `<html><body>Fixture search${scenario === 'iframe_denied' ? '<iframe src="/irrelevant-frame"></iframe>' : ''}<script>fetch("/appsync/lfs");</script></body></html>` });
            }
          });
          return context;
        };
        return browser;
      },
    };
    const report = await collect({ url: 'https://www.aircanada.com/fixture', out,
      timeout: 8, executable: process.env.AEROPLAN_TEST_EXECUTABLE }, { browserType });
    const expected = { iframe_denied: 'success', document_error: 'upstream_error', api_denied: 'blocked', network_failed: 'network_error', login_redirect: 'authentication_required' }[scenario] ?? scenario;
    assert.equal(report.status, expected, scenario);
    if (scenario === 'blocked') {
      assert.equal(report.failureDetails.stage, 'document');
      assert.equal(report.failureDetails.status, 403);
      assert.equal(report.failureDetails.server, 'AkamaiGHost');
      assert.ok(report.notes.some(note => note.includes('Akamai')));
    }
    if (scenario === 'document_error') assert.equal(report.failureDetails.status, 503);
    if (scenario === 'api_denied') assert.equal(report.failureDetails.stage, 'search_response');
    if (scenario === 'network_failed') assert.equal(report.failureDetails.networkCode, 'net::ERR_CONNECTION_REFUSED');
    if (scenario === 'login_redirect') assert.equal(report.failureDetails.reason, 'login_redirect');
    const offers = JSON.parse(await readFile(join(out, 'offers.json'), 'utf8'));
    if (scenario !== 'document_error') assert.equal(offers.length, expected === 'success' ? 1 : 0);
    if (scenario === 'success') {
      const captures = JSON.parse(await readFile(join(out, 'captures.json'), 'utf8'));
      assert.equal(captures[0].body.data.getFareRedemption.searchInformation.sessionID, '[REDACTED]');
      assert.equal(offers[0].points, 75000);
    }
  }
});
