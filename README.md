# Aeroplan scraper prototype

A standalone Node.js / Playwright collector for **one route and departure date at a time**. It opens Air Canada's normal reward-search page and observes the search responses produced by that page. It does not use Seats.aero or another data supplier.

The generated deep link and built-in parser are experimental. The parser supports the GraphQL `boundSolution → flightSegments / fare.cabins / redemptionBooking` shape seen in public Aeroplan integration code. It does **not** claim compatibility with every current Aeroplan response. Other schemas, including Amadeus `airBoundGroups`, are preserved for inspection and produce `schema_unrecognized`, not an empty-success result.

## Run

Requires Node.js 22 or later.

```bash
git clone https://github.com/hursharora/Aeralo.git
cd Aeralo
npm ci
npm run install-browser
npm run scrape -- --login --profile .profiles/aeroplan
npm run scrape -- --from YVR --to NRT --date 2027-02-10 --adults 2 --profile .profiles/aeroplan
```

Visible Chromium is now the default: it loaded the site in this environment, while headless Chromium received an access denial. Use `--headless` explicitly when needed; it is not currently a verified working collection mode here. `--login` requires an interactive terminal: sign in only in the airline's visible page, then press Enter in the terminal to save and close the dedicated profile. The profile is sensitive local session storage. No credentials are collected by the CLI, and pressing Enter does not itself verify authentication.

If Linux reports missing shared libraries, install Playwright's OS dependencies with `npx playwright install-deps chromium`.

In this workspace, the matching Playwright Chromium is installed. Since system installation required a sudo password, Ubuntu's `libasound2` package was extracted into the ignored `.browser-libs/` folder instead. The collector automatically adds that directory to the child browser's library path on Linux; no temporary environment override is required. On another machine, use the standard dependency installation above.

If Air Canada changes the deep link, pass a URL copied from its reward search instead:

```bash
npm run scrape -- --url 'https://www.aircanada.com/aeroplan/redeem/availability/outbound?...' --headed --timeout 120
```

In the visible browser you can submit the ordinary search manually during the collection window, including any cookie consent required. Keep the browser on the same route/date. This prototype does not automate form selectors or credential entry. `--profile .profiles/aeroplan` reuses the dedicated profile created by `--login`. That folder contains session data; do not commit or share it. Without `--profile`, a temporary anonymous profile is used and the reward page may require sign-in. Login redirects produce `authentication_required` immediately instead of waiting for a timeout.

Use `--executable /path/to/chromium` to choose an existing compatible Chromium installation. `--timeout` bounds the live capture window (5–300 seconds; default 45), with browser startup/cleanup overhead. The collector stops on search or top-level document 401, 403, or 429 responses, or recognizable denial/challenge text. An unrelated iframe denial does not fail the search. It does not retry denied requests.

## Offline demonstration

```bash
npm run demo
npm test
npm run scrape -- --replay output/RUN/captures.json --out output/reparsed
```

`AEROPLAN_BROWSER_TESTS=1 npm test` also runs optional Chromium integration scenarios covering successful capture, document/API denial, an unrelated iframe denial, HTTP server errors, connection failure, login redirect, and an unknown schema. Every URL in that test is fulfilled locally; it sends no airline traffic. Set `AEROPLAN_TEST_EXECUTABLE` if using an existing Chromium binary.

The included fixture is **synthetic**, with invented flight numbers, prices, and availability. Demo success validates parsing and file output; it is not proof of live collection. Replaying a raw JSON response gives a null observation time. Replaying a capture preserves its original observation time.

## Output

Each live run writes an ignored `output/<timestamp>/` directory:

| File | Contents |
| --- | --- |
| `report.json` | Outcome, browser version, navigation status, failure stage/reason, endpoint, response server/content type, number of responses and offers, diagnostic notes |
| `offers.json` | Recognized itineraries, segment cabins, points, cash, currency, source, and observation time |
| `captures.json` | Search response bodies after best-effort redaction; usable for offline parser development |
| `network.json` | Up to 300 Air Canada document/XHR/fetch endpoint paths and HTTP statuses |

No request bodies, request headers, cookies, full URL query strings, screenshots, or browser HTML are exported. Only the response server name and content type are retained as diagnostic headers. Response redaction is key-based and best effort: inspect captures before sharing, especially after using an authenticated profile. New output directories/files are created with owner-only permissions where supported.

Prices retain the supplier's numeric values and use `priceBasis: supplier_reported_unverified`. They are not divided by passenger count or advertised as per-person prices until the live schema's semantics are verified. Seat counts are recorded per segment only when explicitly supplied. Missing seat counts and cabin details stay null; passenger count is not treated as remaining inventory. Supplier timestamps, time zones, and offsets are retained as received.

Outcomes include `success`, `no_availability`, `partial`, `schema_unrecognized`, `upstream_error`, `network_error`, `blocked`, `authentication_required`, `timeout`, `no_search_response`, `browser_closed`, and `browser_error`. Only a recognized explicitly empty `boundSolution` collection can produce `no_availability`. Success uses a 2.5-second quiet-period heuristic; it does not establish exhaustive search completeness or ticketability.

Exit code 0 means recognized success or empty availability; 2 means an incomplete/failed collection; 1 means invalid arguments or an unexpected CLI error. Inspect the report even when offers are present.

## Next iteration

Run one real search, inspect `report.json` and the sanitized response shape in `captures.json`, then adapt `src/core.js` to that payload and add a sanitized fixture. Validate fare totals, price basis, passenger count, and segment-level details against the same search in the UI before scheduling collection.

## Validation in this workspace

Diagnostic output and local browser libraries described below are excluded from Git. A fresh clone uses the browser setup instructions above.

The initial test suite passed using local fixtures. Debugging compared three ordinary browser navigations: the homepage, the bare reward-search page, and a generated search URL. All returned HTTP 403, `server: AkamaiGHost`, and an Access Denied page, before any flight search response. See `output/debug-comparison/results.json`.

The correct Chromium version was then installed and the headless search was checked again, with the same denial. The enhanced report in `output/debug-verified/report.json` identifies the failure at the top-level document. It does not identify the exact deciding rule.

A subsequent **visible Chromium** check loaded the homepage with HTTP 200 (`output/debug-headed-home/report.json`). The visible reward-search page also loaded, then redirected to `/clogin/pages/login` (`output/debug-headed-search/report.json`). That redirect was originally misreported as a timeout; it is now correctly reported as `authentication_required`. These results motivated visible mode by default and the manual profile login command. Live authenticated extraction and current price semantics remain unverified until a user signs in. No denied request is retried automatically.

The default command was verified without an executable or library environment override: `output/debug-authentication/report.json` records visible Chromium 158.0.8127.18, HTTP 200 for the login document, and `authentication_required` with reason `login_redirect`.

Air Canada's [website terms](https://www.aircanada.com/ca/en/aco/home/legal/terms-of-use.html) restrict automated extraction. Aeroplan's [membership terms](https://www.aircanada.com/ca/en/aco/home/aeroplan/legal/terms-and-conditions.html) also address automated participation. This prototype contains no login automation, proxy rotation, challenge solving, or access-control bypass.

Implementation reference: [Playwright network events](https://playwright.dev/docs/network). Historical schema reference: [public Aeroplan GraphQL integration](https://github.com/xmsley614/nt_tool/blob/main/src/ac_searcher2.py). Code in this project is written independently; the sample fixture is invented.
