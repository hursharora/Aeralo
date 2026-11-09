import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildSearchUrl, isAirCanadaUrl, normalize, redact, summarize } from './core.js';

const help = `Aeroplan single-search collector (Node 22+)

  npm run scrape -- --from YVR --to NRT --date 2027-02-10
  npm run scrape -- --url 'YOUR_AIR_CANADA_SEARCH_URL' --headed --timeout 120
  npm run scrape -- --login --profile .profiles/aeroplan
  npm run scrape -- --replay output/RUN/captures.json
  npm run demo

Options:
  --from / --to    Three-letter IATA airport codes
  --date          Future departure date, YYYY-MM-DD
  --adults        Adults, 1–9 (default 1)
  --url           Exact Air Canada search URL; alternative to route/date
  --headed        Show browser (default); manually submit search if needed
  --headless      Run without a visible window (denied in this environment)
  --login         Sign in manually in a dedicated --profile (interactive terminal)
  --timeout       Total collection window in seconds, 5–300 (default 45)
  --profile       Optional dedicated browser profile directory
  --executable    Optional Chromium executable path
  --replay        Parse saved captures or a JSON response without a browser
  --out           Output directory (default output/<timestamp>)

Generated deep-link parameters and the experimental GraphQL parser need live
validation. Unknown payloads are saved and reported as schema_unrecognized.
`;

async function main() {
  const { values } = parseArgs({ options: {
    from: { type: 'string' }, to: { type: 'string' }, date: { type: 'string' },
    adults: { type: 'string', default: '1' }, url: { type: 'string' },
    headed: { type: 'boolean', default: false }, headless: { type: 'boolean', default: false }, login: { type: 'boolean', default: false }, timeout: { type: 'string' },
    profile: { type: 'string' }, executable: { type: 'string' }, replay: { type: 'string' },
    out: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { console.log(help); return; }
  if (values.headed && values.headless) throw new Error('Choose either --headed or --headless');
  if (values.login) {
    if (!values.profile || values.replay || values.url || values.from || values.to || values.date || values.headless) throw new Error('--login requires --profile and cannot be combined with a search, replay, or --headless');
    const timeout = Number(values.timeout ?? 300);
    if (!Number.isInteger(timeout) || timeout < 5 || timeout > 300) throw new Error('--timeout must be 5–300 seconds');
    const { login } = await import('./login.js');
    await login({ profile: resolve(values.profile), executable: values.executable, timeout });
    return;
  }
  const out = resolve(values.out ?? join('output', new Date().toISOString().replaceAll(':', '-')));
  let report;
  if (values.replay) {
    const input = JSON.parse(await readFile(values.replay, 'utf8'));
    const captures = Array.isArray(input) ? input.map(c => ({
      ...c, parsed: c.status >= 200 && c.status < 300 && c.body
        ? normalize(c.body, { observedAt: c.observedAt, source: c.endpoint }) : undefined,
    })) : [{ status: 200, parsed: normalize(input) }];
    const result = summarize(captures);
    report = { mode: 'replay', status: result.status, offerCount: result.offers.length,
      note: 'Offline parsing only; does not verify live availability. Original observation time is preserved when available.' };
    await mkdir(out, { recursive: true, mode: 0o700 });
    await writeFile(join(out, 'offers.json'), JSON.stringify(redact(result.offers), null, 2), { mode: 0o600 });
    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  } else {
    const adults = Number(values.adults);
    const timeout = Number(values.timeout ?? 45);
    if (!Number.isInteger(adults) || adults < 1 || adults > 9) throw new Error('--adults must be 1–9');
    if (!Number.isInteger(timeout) || timeout < 5 || timeout > 300) throw new Error('--timeout must be 5–300 seconds');
    if (values.url && (values.from || values.to || values.date)) throw new Error('Use either --url or --from/--to/--date');
    let url = values.url;
    if (!url) {
      const origin = values.from?.toUpperCase();
      const destination = values.to?.toUpperCase();
      if (!/^[A-Z]{3}$/.test(origin ?? '') || !/^[A-Z]{3}$/.test(destination ?? '') || origin === destination) throw new Error('Provide distinct --from and --to IATA codes');
      const date = values.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date < new Date().toISOString().slice(0, 10)) throw new Error('--date must be a valid future YYYY-MM-DD date');
      url = buildSearchUrl({ origin, destination, date, adults });
    }
    if (!isAirCanadaUrl(url)) throw new Error('--url must be an HTTPS aircanada.com URL');
    const { collect } = await import('./collect.js');
    report = await collect({ url, out, timeout, headed: !values.headless,
      profile: values.profile ? resolve(values.profile) : undefined, executable: values.executable });
  }
  console.log(JSON.stringify({ ...report, output: out }, null, 2));
  process.exitCode = ['success', 'no_availability'].includes(report.status) ? 0 : 2;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
