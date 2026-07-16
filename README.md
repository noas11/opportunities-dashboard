# לוח מחוונים — הזדמנויות שנוצרו לאורך זמן

Dashboard showing Opportunities created over time from the SAP Sales Cloud
V2 Opportunities API, with Current Day / Current Month / Current Year views
and drill-down by Date, Media, and Project. The UI itself is in Hebrew (RTL).

## Why there's a small backend

SAP Basic Auth credentials must never be sent from the browser — anyone could
open dev tools and read them. This project ships a tiny Express server that:

- Reads `SAP_USERNAME` / `SAP_PASSWORD` from environment variables
- Builds the `Authorization: Basic base64(username:password)` header
- Calls the SAP API server-side and streams the results to the browser
- Computes today's date at request time and builds the `$filter` — the date
  is never hardcoded
- Translates `extensions.Z_media` / `extensions.Z_project` numeric codes to
  descriptions before the response ever reaches the browser

The frontend (`public/`) is a static dashboard that only ever talks to your
own server, never to SAP directly.

## Setup

```bash
npm install
cp .env.example .env
# edit .env and set SAP_USERNAME / SAP_PASSWORD
npm start
```

Then open **http://localhost:3000**.

## Environment variables

| Variable        | Required | Description                                                                 |
|-----------------|----------|-------------------------------------------------------------------------------|
| `SAP_USERNAME`  | yes      | SAP Sales Cloud username, used for HTTP Basic Auth                          |
| `SAP_PASSWORD`  | yes      | SAP Sales Cloud password, used for HTTP Basic Auth                          |
| `SAP_BASE_URL`  | no       | Overrides the default Opportunities endpoint                                |
| `PORT`          | no       | Server port, default `3000`                                                 |
| `USE_MOCK_DATA` | no       | Set to `true` to run the UI against generated sample data instead of SAP    |

## How the date filter works

On every request to `/api/opportunities?period=day|month|year`, the server
computes the start date **at request time** (never hardcoded) and builds:

- **day** → `?$filter=startDate ge '2026-07-16'` (today)
- **month** → `?$filter=startDate ge '2026-07-01'` (first of this month)
- **year** → `?$filter=startDate ge '2026-01-01'` (first of this year)

## How aggregation works

The server proxies the raw Opportunity records (following SAP's pagination,
whether it returns OData v4 `value` / `@odata.nextLink` or OData v2
`d.results` / `d.__next`) to the browser, after applying the value mappings
below. The browser then aggregates on the fly based on the selected
**Group by** dimension:

- **Date** — Year view groups by month (Jan–Dec); Month view groups by day
  (01–31 of the current month); Day view shows a single total for today
- **Media** — `extensions.Z_media` is an **array** (an Opportunity can carry
  more than one media code). Each code is mapped individually, and the
  opportunity is counted once *per media value it contains* — so a single
  opportunity with two media codes contributes to two bars. This means the
  Media chart's bar totals can exceed the "Total Opportunities" KPI, which
  always reflects the unique opportunity count.
- **Project** — `extensions.Z_project` is a single code per opportunity,
  grouped normally (one opportunity = one bar).

Aggregating client-side means switching "Group by" is instant and doesn't
re-hit the SAP API — only changing the time period triggers a new request.

## Value mapping (codes → descriptions)

SAP returns numeric codes for `extensions.Z_media` (an array of codes) and
`extensions.Z_project` (a single code). These are translated to
human-readable descriptions **server-side**, before anything reaches the
browser — the raw codes never appear in the API response or the UI.

- `data/media-mapping.json` — generated from the provided media mapping
  (57 codes, e.g. `"325": "אשדוד נט"`, `"1": "WEB"`). Each element of the
  `Z_media` array is looked up individually — e.g. `["43","77"]` becomes
  `["madlan", "kishurit"]`, never a joined string like `"43,77"`.
- `data/project-mapping.json` — generated from the provided
  `project_mapping.xlsx` (107 codes, e.g. `"1000005125": "NH15-YAMA עיר ימים"`)

If a code has no entry in the mapping file, the dashboard shows **"לא ממופה"**
("not mapped") instead of the code, and the server logs a warning naming the
missing code so it can be added to the source Excel file and regenerated.
Empty/missing values show **"לא צוין"** ("unspecified").

To refresh these files after the source Excel sheets change, re-export each
sheet's `code`/`description` columns to JSON (`{ "<code>": "<description>" }`)
and overwrite the corresponding file in `data/`.

## Localization

The UI is fully in Hebrew with an RTL layout (`<html lang="he" dir="rtl">`),
including the KPI cards, period/drill-down selectors, chart title, axis
titles, tooltips, loading state, and empty state. Numeric values (counts,
dates) are kept in Western digits, which is standard practice in Hebrew
business UIs.

## Chart layout: vertical vs. horizontal

Every category label is always shown — Chart.js's automatic label-skipping
(`autoSkip`) is disabled, so no Media, Project, or date label is ever hidden.

- **10 or fewer categories** → a standard vertical column chart, with
  rotated labels (45°–60°) if there are more than a handful.
- **More than 10 categories** (common for Media/Project, and for the
  31-day Month view or 12-month Year view) → the chart automatically
  switches to a **horizontal bar chart**. The card scrolls vertically to
  fit every category at a readable row height, instead of squeezing dozens
  of bars into a fixed-height chart. This is handled in `drawChart()` in
  `public/app.js`.

## Chart.js loading

`public/index.html` loads Chart.js from cdnjs at a pinned, verified version:

```
https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js
```

An earlier version of this project pointed at `4.4.4`, a version that was
never published to cdnjs — the request 404'd, the script tag silently failed
to load, `window.Chart` was never defined, and `new Chart(...)` in
`public/app.js` threw `Uncaught ReferenceError: Chart is not defined`. If you
ever change the pinned version, verify the exact URL resolves (e.g.
`curl -I <url>` should return `200`, not `404`) before shipping it — cdnjs
does not publish every patch version of every library.

As a safety net, `drawChart()` in `public/app.js` also checks
`typeof Chart === 'undefined'` before constructing a chart. If the CDN is
ever unreachable (network issue, corporate proxy blocking cdnjs, etc.), the
dashboard shows a clear Hebrew error state instead of crashing.

## Project structure

```
opportunities-dashboard/
├── server.js            Express server + SAP proxy (Basic Auth, pagination, value mapping)
├── package.json
├── .env.example
├── data/
│   ├── media-mapping.json    Z_media code → description
│   └── project-mapping.json  Z_project code → description
└── public/
    ├── index.html        Dashboard markup (Hebrew, RTL)
    ├── style.css          Design system + layout
    └── app.js             Fetching, aggregation, Chart.js rendering, states
```

## Notes

- This project was built and reviewed for correctness against the SAP API
  contract described in the spec, but it has not been run against a live
  SAP Sales Cloud V2 tenant (this environment has no network access to
  `*.crm.cloud.sap`). Set `USE_MOCK_DATA=true` to sanity-check the UI first,
  then point it at your real tenant.
- If your tenant's extension field names differ from `Z_media` / `Z_project`,
  update `applyValueMappings()` in `server.js`.
- If the API ever returns a 401, double check `SAP_USERNAME` / `SAP_PASSWORD`
  — the server always sends Basic Auth and never falls back to OAuth,
  bearer tokens, or an API key.
