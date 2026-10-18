# StockPlay

A portfolio **dashboard**, a **control page** and an **audit trail** for a book
that holds several different types of stock. The dashboard answers *where does
the money sit and how is it doing*; the control page is where you trade, set the
risk limits per stock type, manage the instrument book and drive the market
simulation that feeds it all; the audit trail is what the reviewer reads
afterwards.

Who can do which of those is decided by a **role**, and the API — not the form —
is what enforces it.

Everything runs locally against a simulated market — no market-data vendor, no
API keys.

## Stock types

Six types are modelled, each with its own behaviour in the simulation rather
than just a different label:

| Type | Behaves like |
|---|---|
| **Common stock** | Ordinary shares. Medium volatility, small dividend. |
| **Preferred stock** | Bond-like: muted price swings, a large fixed dividend. |
| **ETF** | A diversified basket, so single-name shocks are damped. |
| **REIT** | Rate sensitive, distribution heavy. |
| **ADR** | Foreign issuer listed locally; the widest swings of the six. |
| **Mutual fund** | Prices once per NAV window, not continuously through the day. |

Each type owns one colour slot for its whole life. Filtering a type out of a
view never repaints the ones that remain.

## Roles

Three roles, each with a fixed set of permissions. The split is deliberate:
nobody both places orders and sets the limits that constrain them, and only the
reviewer can annotate the record.

| | Trader | Risk manager | Auditor |
|---|:---:|:---:|:---:|
| View the dashboard | ✓ | ✓ | ✓ |
| Place orders | ✓ | | |
| Manage the instrument book | ✓ | ✓ | |
| Set per-type risk limits | | ✓ | |
| Drive the simulation | | ✓ | |
| Acknowledge alerts | ✓ | ✓ | ✓ |
| Read the audit trail | | ✓ | ✓ |
| Write review notes | | | ✓ |
| Export CSV | ✓ | ✓ | ✓ |

Pick the role from the header. Switching it re-reads everything, because what
the server returns — and refuses — depends on it. Controls the role cannot use
are disabled and say why, rather than silently failing.

### The auditor

The auditor is a read-only reviewer. It sees every page, but every control on
the control page is inert, and the API answers a mutation with `403` and a
message naming the missing permission. In exchange it gets the **Audit** tab:

- **The full trail** — every order, every limit change with its before/after
  value, every edit to the book, every simulation change, every alert
  acknowledgement, and every *refused* attempt. Filter by action, by actor, by
  free text across summaries and notes, or narrow to entries already reviewed.
- **Review notes** — a note against any entry ("Reviewed — within mandate",
  "Query raised"). Notes are part of the record and travel into the export.
- **CSV export** — the trail as filtered, plus holdings and orders.

A refusal is itself recorded, so an attempt to act outside a role is visible to
the reviewer rather than vanishing into a status code.

### Is this access control?

By default, **no** — and the UI says so with an `unverified` badge next to the
role. A request simply names its role and the server believes it, which is
honest for a single-user tool on localhost but is not security.

To make the distinction hold, give each role a token:

```bash
STOCKPLAY_ROLE_TOKENS='{"TRADER":"…","RISK_MANAGER":"…","AUDITOR":"…"}' npm start
```

With that set, a request must present `X-StockPlay-Token` matching the role in
`X-StockPlay-Role`; anything else drops to the least-privileged role (auditor)
rather than being rejected outright, so a viewer without a token still sees a
working dashboard. This is a shared-secret scheme, not per-user accounts: it
separates duties between people who are already trusted to reach the service.
It does not replace a real login, and there is still no per-user identity — the
trail records the role that acted, not a person.

## Running it

```bash
npm install
npm run dev          # API on :4000, dashboard on :5173
```

Open <http://localhost:5173>. The Vite dev server proxies `/api` to the API, so
there is nothing else to configure.

To run the built app from a single origin:

```bash
npm start            # builds web + server, then serves both on :4000
```

Other scripts:

| Script | Does |
|---|---|
| `npm test` | Runs the engine test suite (simulation, portfolio maths, orders, alerts). |
| `npm run typecheck` | Typechecks every workspace. |
| `npm run build` | Builds shared types, the API and the web bundle. |
| `npm run dev:server` / `npm run dev:web` | Runs one half on its own. |

## The dashboard

One filter row scopes the whole page: which stock types to include, and how far
back to look. Every tile, chart and table below re-renders against that same
slice.

- **Stat tiles** — total portfolio, value of the selected types, unrealized
  P/L, and cash including the dividend income credited so far.
- **Value of selected stock types** — the value curve over the window. Hover
  for a crosshair, or focus the chart and use ← → to read any point from the
  keyboard.
- **Mix by stock type** — part-to-whole across at most six segments.
- **Return by stock type** — unrealized return against average cost, on a zero
  baseline.
- **Held against target** — each type's weight with a tick marking the target
  set on the control page, plus a small trend line per type.
- **Holdings** — every position, sortable by any column.
- **Open alerts** — whatever has crossed a threshold, acknowledgeable in place.

Every chart has a **Table** toggle showing the same numbers, so no value is
reachable only by hovering.

## The control page

- **Trade ticket** — market buys and sells at the current simulated price, with
  the order value, the resulting cash and the reason a rejected order would be
  rejected shown before you submit.
- **Market simulation** — run/pause, how much simulated time passes per tick,
  how often a tick fires, a global volatility multiplier and a sentiment bias
  from bearish to bullish.
- **Per-type limits** — one card per stock type: a trading on/off switch,
  target allocation, a cap on any single position, a day-move alert threshold,
  a stop-loss threshold, and a volatility factor that changes how hard that
  type moves in the simulation.
- **Instrument book** — add a stock, reclassify it, suspend it, or remove it
  once its position is closed.
- **Alerts** and **recent orders**.

Limits are enforced by the API, not just by the form. Turning trading off for a
type or lowering its position cap makes the server reject a breaching order
with a 422 and an explanation, whatever the client sends.

What is usable here depends on the role: a trader gets the ticket and the book,
a risk manager gets the limits and the simulation, an auditor gets neither —
every control is disabled and says so. Each change that does go through is
written to the audit trail with its before and after value.

## The audit trail

The reviewer's page, open to the auditor and the risk manager. See
[Roles](#roles) above for what it holds and who may annotate it.

## How it fits together

```
shared/    Domain types and the per-type profiles, used by both sides.
server/    Express API + the market simulation.
  auth.ts  role resolution and the permission guard
  engine/  market (price paths), portfolio (derived figures),
           trading (order rules), alerts (threshold checks),
           audit (the trail, diffs and CSV)
  store/   In-memory state, seeded, persisted to server/data/state.json
  routes/  REST endpoints and the SSE stream
web/       React + Vite front end.
  charts/  Hand-rolled SVG charts
  pages/   DashboardPage, ControlPage, AuditPage
```

The API keeps the book in memory and writes it to `server/data/state.json` at
most once a second, so a restart resumes where it left off. Delete that file to
start from the seed book again.

Prices move on a tick loop and are pushed to every open page over
Server-Sent Events (`GET /api/stream`), so two open tabs stay in step. Price
paths use a seeded PRNG: the same seed replays the same path, which is what
makes the engine testable.

### API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/portfolio` | Holdings, per-type summaries, totals |
| `GET` | `/api/history?points=` | Portfolio value samples |
| `GET` | `/api/instruments` | The book |
| `POST` | `/api/instruments` | Add a stock |
| `PATCH` | `/api/instruments/:id` | Rename, reclassify, suspend, reprice |
| `DELETE` | `/api/instruments/:id` | Remove (refused while a position is open) |
| `POST` | `/api/orders` | Place a market order |
| `GET` | `/api/orders?limit=` | Recent fills |
| `GET`/`PATCH` | `/api/controls[/:type]` | Per-type limits |
| `GET`/`PATCH` | `/api/engine` | Simulation settings |
| `GET` | `/api/alerts` | Alert feed |
| `POST` | `/api/alerts/:id/ack`, `/api/alerts/ack-all` | Acknowledge |
| `GET` | `/api/me` | The caller's role and permissions |
| `GET` | `/api/audit` | The trail; `action`, `actor`, `search`, `noted` filters |
| `POST` | `/api/audit/:id/notes` | Add a review note |
| `GET` | `/api/export/audit.csv` | The trail as filtered |
| `GET` | `/api/export/holdings.csv`, `/api/export/orders.csv` | Positions and fills |
| `GET` | `/api/stream` | SSE: ticks, alerts, settings, book changes |

Every mutating endpoint needs a permission: `trade` for orders,
`controls:manage` for limits, `engine:manage` for the simulation,
`instruments:manage` for the book, `alerts:ack` to acknowledge,
`audit:read` / `audit:note` for the trail, `export` for CSV. A request without
it gets `403` with the role and the missing permission named, and the refusal
is written to the trail. The role travels in `X-StockPlay-Role`; the SSE stream
takes `?role=` instead, since EventSource cannot send headers.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | API port |
| `STOCKPLAY_DATA_FILE` | `server/data/state.json` | Where state is persisted |
| `STOCKPLAY_WEB_DIST` | auto-detected | Web bundle to serve from the API |
| `STOCKPLAY_API` | `http://localhost:4000` | Proxy target for the Vite dev server |
| `STOCKPLAY_ROLE_TOKENS` | unset | JSON `{role: token}`; unset means roles are self-declared |

## Notes on the charts

Colours come from a categorical palette validated for colour-vision deficiency
in both light and dark mode; dark mode uses its own steps chosen for the dark
surface rather than a flipped light palette. Because the palette clears its
thresholds on *neighbouring* slots, the donut keeps the fixed type order instead
of sorting by value — which also stops the ring reshuffling on every tick.
Identity is never carried by colour alone: charts carry a legend and direct
labels, tables name the type in words, and up/down carries an arrow and a sign
as well as a colour.

## Caveats

The market is a simulation, not a feed, and the numbers it produces are not
advice about anything.

There is still no authentication in the sense of accounts and passwords. Roles
separate duties; with `STOCKPLAY_ROLE_TOKENS` set they do so against a shared
secret, and without it they are a convention the server honours. Either way the
trail records a *role*, not a person, so it answers "what was changed and under
which authority", not "who was sitting at the keyboard". Treat the service as
something you put behind your own front door.
