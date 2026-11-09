import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSearchUrl, endpoint, isAirCanadaUrl, isSearchResponse, isLoginPage, normalize, pageFailure, redact, summarize } from '../src/core.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/graphql.json', import.meta.url), 'utf8'));
const sample = () => structuredClone(fixture);
const solution = payload => payload.data.getFareRedemption.bound[0].boundSolution[0];

test('normalizes a complete mixed-cabin itinerary without inventing price basis or inventory', () => {
  const result = normalize(sample(), { observedAt: '2026-11-08T12:00:00Z', source: 'fixture' });
  assert.equal(result.status, 'success');
  assert.equal(result.offers.length, 1);
  const offer = result.offers[0];
  assert.equal(offer.points, 75000);
  assert.equal(offer.cash, 112.34);
  assert.equal(offer.currency, 'CAD');
  assert.equal(offer.origin, 'YVR');
  assert.equal(offer.destination, 'NRT');
  assert.equal(offer.segments[0].cabin, 'Economy');
  assert.equal(offer.segments[1].reportedSeats, null);
  assert.equal(offer.priceBasis, 'supplier_reported_unverified');
  assert.equal(offer.observedAt, '2026-11-08T12:00:00Z');
  assert.equal(offer.arrival, '2027-02-11T16:00:00+09:00');
});

test('only an explicitly recognized empty collection means no availability', () => {
  assert.equal(normalize({ data: { bound: [{ boundSolution: [] }] } }).status, 'no_availability');
  for (const payload of [{}, { data: null }, { data: { airBoundGroups: [] } }, { data: { bound: [] } }]) {
    assert.equal(normalize(payload).status, 'schema_unrecognized');
  }
  assert.equal(normalize({ errors: [{ message: 'Unavailable' }] }).status, 'upstream_error');
});

test('incomplete and revenue-only responses cannot produce successful award results', () => {
  for (const mutate of [
    p => delete solution(p).fare.cabins[0].fareAvailable[0].redemptionBooking,
    p => delete solution(p).flightSegments[1].destinationAirport,
    p => { solution(p).fare.cabins[0].fareAvailable[0].redemptionBooking.pointsPortion.fareTotalPoints = null; },
  ]) {
    const payload = sample(); mutate(payload);
    assert.equal(normalize(payload).status, 'partial');
    assert.equal(normalize(payload).offers.length, 0);
  }
});

test('deduplicates offers while keeping different departures distinct', () => {
  const payload = sample();
  payload.data.getFareRedemption.bound[0].boundSolution.push(structuredClone(solution(payload)));
  assert.equal(normalize(payload).offers.length, 1);
  payload.data.getFareRedemption.bound[0].boundSolution[1].flightSegments[0].scheduledDepartureDateTime = '2027-02-11T08:00:00-08:00';
  assert.equal(normalize(payload).offers.length, 2);
});

test('malformed flight and fare elements are partial results rather than exceptions', () => {
  for (const mutate of [
    p => { p.data.getFareRedemption.bound[0].boundSolution = [null]; },
    p => { solution(p).flightSegments = [null]; },
    p => { solution(p).fare.cabins = [null]; },
    p => { solution(p).fare.cabins[0].fareAvailable = [null]; },
  ]) {
    const payload = sample(); mutate(payload);
    assert.equal(normalize(payload).status, 'partial');
  }
});

test('redacts nested identity and session fields, and strips URL credentials/query/fragment', () => {
  const clean = redact({ email: 'person@example.test', nested: [{ access_token: 'secret', sessionID: 'secret', points: 75000, selectionID: 'secret' }] });
  assert.equal(clean.email, '[REDACTED]');
  assert.equal(clean.nested[0].access_token, '[REDACTED]');
  assert.equal(clean.nested[0].sessionID, '[REDACTED]');
  assert.equal(clean.nested[0].points, 75000);
  assert.equal(endpoint('https://user:pass@www.aircanada.com/search?token=secret#secret'), 'https://www.aircanada.com/search');
});

test('search discovery is scoped to Air Canada hosts and known search endpoints', () => {
  assert.equal(isSearchResponse('https://akamai-gw.dbaas.aircanada.com/appsync/lfs'), true);
  assert.equal(isSearchResponse('https://www.aircanada.com/v2/search/air-bounds'), true);
  assert.equal(isSearchResponse('https://example.com/air-bounds'), false);
  assert.equal(isSearchResponse('https://aircanada.com.evil.test/air-bounds'), false);
  assert.equal(isSearchResponse('https://www.aircanada.com/accounts.login'), false);
  assert.equal(isAirCanadaUrl('http://www.aircanada.com/'), false);
});

test('failures take precedence over available or empty results', () => {
  const success = { status: 200, parsed: normalize(sample()) };
  assert.equal(summarize([success], { failure: 'blocked' }).status, 'blocked');
  assert.equal(summarize([success, { status: 500 }]).status, 'upstream_error');
  assert.equal(summarize([], { timedOut: true }).status, 'timeout');
  assert.equal(pageFailure('Access Denied'), 'blocked');
  assert.equal(pageFailure('Sign in to continue'), 'authentication_required');
  assert.equal(pageFailure('Sign in | Book with points'), null);
});

test('login redirects are detected by their path without matching return URLs or header links', () => {
  assert.equal(isLoginPage('https://www.aircanada.com/clogin/pages/login?redirect=search'), true);
  assert.equal(isLoginPage('https://www.aircanada.com/sign-in'), true);
  assert.equal(isLoginPage('https://www.aircanada.com/search?returnUrl=/login'), false);
  assert.equal(isLoginPage('https://example.com/login'), false);
});

test('builds a one-way reward search with the requested adult count', () => {
  const url = new URL(buildSearchUrl({ origin: 'YVR', destination: 'NRT', date: '2027-02-10', adults: 2 }));
  assert.equal(url.searchParams.get('org1'), 'YVR');
  assert.equal(url.searchParams.get('ADT'), '2');
  assert.equal(url.searchParams.get('isReward'), 'true');
});

test('CLI offline replay writes offers and keeps unknown observation time unknown', async () => {
  const out = await mkdtemp(join(tmpdir(), 'aeroplan-replay-'));
  execFileSync(process.execPath, ['src/cli.js', '--replay', 'test/fixtures/graphql.json', '--out', out]);
  const offers = JSON.parse(await readFile(join(out, 'offers.json'), 'utf8'));
  assert.equal(offers.length, 1);
  assert.equal(offers[0].observedAt, null);
  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
  assert.equal(report.mode, 'replay');
});
