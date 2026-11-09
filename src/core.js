import { createHash } from 'node:crypto';

export const PARSER_VERSION = '0.1.0';
const list = value => Array.isArray(value) ? value : value ? [value] : [];
const number = value => {
  if (value === null || value === undefined || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
};

export function buildSearchUrl({ origin, destination, date, adults = 1 }) {
  const url = new URL('https://www.aircanada.com/aeroplan/redeem/availability/outbound');
  url.search = new URLSearchParams({
    tripType: 'O', org1: origin, dest1: destination,
    departure1: date, ADT: String(adults), YTH: '0', CHD: '0', INF: '0',
    INS: '0', marketCode: 'INT', isReward: 'true',
  }).toString();
  return url.href;
}

export function isAirCanadaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      (url.hostname === 'aircanada.com' || url.hostname.endsWith('.aircanada.com'));
  } catch { return false; }
}

export function isSearchResponse(value) {
  if (!isAirCanadaUrl(value)) return false;
  return /\/(?:air-bounds|appsync\/lfs|graphql)(?:\/|\?|$)/i.test(new URL(value).pathname);
}

export function isLoginPage(value) {
  if (!isAirCanadaUrl(value)) return false;
  return /^\/(?:clogin\/pages\/login|login|signin|sign-in|accounts\/login)(?:\/|$)/i.test(new URL(value).pathname);
}

// URLs and browser headers can contain session material. Persist endpoint paths only.
export function endpoint(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch { return '[invalid URL]'; }
}

const sensitive = /^(?:.*token.*|.*password.*|.*secret.*|.*cookie.*|authorization|.*session.*|email|emailAddress|firstName|lastName|fullName|phone|phoneNumber|address|dateOfBirth|birthDate|frequentFlyer|frequentFlyerNumber|aeroplanNumber|membershipNumber|accountNumber|uid|signature|selectionID|key|login)$/i;

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, sensitive.test(key) ? '[REDACTED]' : redact(item)]));
  }
  return value;
}

export function pageFailure(text) {
  if (/access denied|request (?:was )?blocked|verify (?:that )?you(?:'re| are) human|unusual traffic|pardon our interruption|too many requests|security challenge/i.test(text)) return 'blocked';
  if (/sign in to (?:continue|search|view)|log in to (?:continue|search|view)|session (?:has )?expired/i.test(text)) return 'authentication_required';
  return null;
}

// Deliberately strict: never turn an arbitrary API error into "no flights".
export function normalize(payload, { observedAt = null, source = null } = {}) {
  const offers = [];
  let recognized = false;
  let incomplete = false;
  let apiError = false;
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (list(node.errors).length || list(node.ac2uErrorsWarnings).some(e => /error/i.test(e.type ?? ''))) apiError = true;
    if (Object.hasOwn(node, 'boundSolution')) {
      if (!Array.isArray(node.boundSolution)) { incomplete = true; return; }
      recognized = true;
      for (const solution of node.boundSolution) {
        if (!solution || typeof solution !== 'object') { incomplete = true; continue; }
        const flights = solution.flightSegments;
        if (!Array.isArray(flights) || !flights.length) { incomplete = true; continue; }
        const cabins = solution.fare?.cabins;
        if (!Array.isArray(cabins) || !cabins.length) { incomplete = true; continue; }
        for (const cabin of cabins) {
          if (!cabin || typeof cabin !== 'object') { incomplete = true; continue; }
          const fares = list(cabin.fareAvailable);
          if (!fares.length) incomplete = true;
          for (const fare of fares) {
            if (!fare || typeof fare !== 'object') { incomplete = true; continue; }
            // Revenue fares are not award offers.
            const redemption = fare.redemptionBooking;
            if (!redemption) { incomplete = true; continue; }
            const points = number(redemption.pointsPortion?.fareTotalPoints);
            if (points === null) { incomplete = true; continue; }
            const bookings = list(fare.bookingClass).filter(b => b && typeof b === 'object');
            const mixed = list(fare.mixedCabin).filter(m => m && typeof m === 'object');
            if (flights.some(f => !f || typeof f !== 'object')) { incomplete = true; continue; }
            const segments = flights.map(flight => {
              const booking = bookings.find(b => String(b.flightNumber) === String(flight.flightNumber) && b.marketingCode === flight.airline?.marketingCode);
              const lowerCabin = mixed.find(m => String(m.flightNumber) === String(flight.flightNumber) && m.marketingCode === flight.airline?.marketingCode);
              return {
                origin: flight.originAirport ?? null,
                destination: flight.destinationAirport ?? null,
                departure: flight.scheduledDepartureDateTime ?? null,
                arrival: flight.scheduledArrivalDateTime ?? null,
                marketingCarrier: flight.airline?.marketingCode ?? null,
                operatingCarrier: flight.airline?.operatingCode ?? null,
                flightNumber: String(flight.flightNumber ?? ''),
                cabin: lowerCabin?.actualCabinName ?? booking?.segmentCabinName ?? null,
                reportedSeats: number(booking?.noOfSeats),
              };
            });
            if (segments.some(s => !s.origin || !s.destination || !s.departure || !s.arrival || !s.flightNumber)) { incomplete = true; continue; }
            const offer = {
              program: 'aeroplan', origin: segments[0].origin,
              destination: segments.at(-1).destination,
              departure: segments[0].departure, arrival: segments.at(-1).arrival,
              cabin: cabin.cabinName ?? cabin.cabinCode ?? null,
              fareFamily: fare.fareFamily ?? null,
              points, cash: number(redemption.cashPortion?.fareTotal),
              currency: redemption.cashPortion?.currencyCode ?? null,
              // Do not guess per-person/group semantics or infer inventory from ADT.
              priceBasis: 'supplier_reported_unverified',
              segments, observedAt, source, parserVersion: PARSER_VERSION,
            };
            offer.id = createHash('sha256').update(JSON.stringify({ ...offer, observedAt: null, source: null })).digest('hex').slice(0, 20);
            offers.push(offer);
          }
        }
      }
      return;
    }
    Object.values(node).forEach(visit);
  };
  visit(payload);
  const unique = [...new Map(offers.map(offer => [offer.id, offer])).values()];
  const status = apiError ? 'upstream_error' : incomplete ? 'partial' :
    !recognized ? 'schema_unrecognized' : unique.length ? 'success' : 'no_availability';
  return { status, offers: unique };
}

export function summarize(captures, { failure = null, timedOut = false } = {}) {
  const offers = [...new Map(captures.flatMap(c => c.parsed?.offers ?? []).map(o => [o.id, o])).values()];
  const statuses = captures.map(c => c.parsed?.status);
  const status = failure ?? (statuses.includes('upstream_error') ? 'upstream_error' :
    captures.some(c => c.status >= 400 || c.error) ? 'upstream_error' :
    statuses.includes('partial') ? 'partial' :
    offers.length ? 'success' :
    statuses.includes('no_availability') && statuses.every(s => s === 'no_availability') ? 'no_availability' :
    captures.length ? 'schema_unrecognized' : timedOut ? 'timeout' : 'no_search_response');
  return { status, offers };
}
