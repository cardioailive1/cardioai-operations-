# Cardio AI Operations Platform

A full-stack COO command center for Cardio AI: the operations dashboard
(frontend) plus an Express backend with **Google Workspace sign-in** and a
persistent REST API. Built to deploy on **Render.com** as a single Node web
service — the same pattern as the Sales Automation Engine.

---

## What's inside

```
cardioai-operations/
├── server.js            # Express backend: Google OAuth + REST API + static serving
├── storage.js           # Data layer: Postgres (prod) or JSON file (local dev)
├── salesConnector.js    # Live-pulls + maps the Sales Engine pipeline into deals
├── seed.json            # Initial data (your real beta sites, team, pipeline, etc.)
├── package.json         # Dependencies + start script
├── render.yaml          # One-click Render Blueprint (web service + Postgres)
├── .env.example         # Environment variable template
├── .gitignore
├── SALES_ENGINE_pipeline_endpoint.js   # Drop-in endpoint to paste into the SALES ENGINE's server.js
└── public/
    ├── index.html       # The full operations dashboard (passcode removed)
    ├── login.html       # Google sign-in page (shown to signed-out users)
    └── app.js           # Frontend runtime: user chip, logout, live data, beta-site CRUD
```

> **Note:** `SALES_ENGINE_pipeline_endpoint.js` is not part of this app — it's a
> snippet you paste into the **sales engine's** `server.js`. See *Sales Engine
> integration* below.

---

## How sign-in works

The old hardcoded passcode (`CardioAI2026!`) is **gone**. Access is now real:

- Visiting any page while signed out redirects to `/login`.
- Employees click **Sign in with Google** and authenticate with their company
  account.
- The server only lets in accounts on your approved domain
  (`ALLOWED_EMAIL_DOMAIN`, default `cardioailive.com`). Anyone else is rejected
  with a clear message — they never receive the dashboard HTML.
- You can also allow specific outside emails (e.g. an advisor on a personal
  account) via `ALLOWED_EMAILS`.
- Sessions are signed cookies; logging out destroys the session server-side.

---

## 1. Set up Google OAuth (one time, ~5 min)

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) →
   create or pick a project.
2. **APIs & Services → OAuth consent screen** → choose **Internal** (if you use
   Google Workspace, this restricts it to your org automatically) → fill app
   name and support email → save.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID** →
   application type **Web application**.
4. Add **Authorized redirect URIs**:
   - Local: `http://localhost:3000/auth/google/callback`
   - Production: `https://YOUR-APP.onrender.com/auth/google/callback`
5. Copy the **Client ID** and **Client secret** into your `.env` (local) and the
   Render dashboard (production).

---

## 2. Run locally

```bash
npm install
cp .env.example .env          # then fill in the values
npm start
```

Open `http://localhost:3000` → you'll be sent to the sign-in page.

Generate a session secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## 3. Deploy to Render.com

**Push to GitHub**

```bash
git init
git add .
git commit -m "Cardio AI Operations Platform"
git remote add origin https://github.com/YOUR_USERNAME/cardioai-operations.git
git push -u origin main
```

**Option A — Blueprint (recommended).** In Render: **New + → Blueprint**, point it
at the repo. `render.yaml` creates the web service **and a managed Postgres
database**, wires `DATABASE_URL` between them, and generates `SESSION_SECRET`.
Then add the three secret variables it asks for (`GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`).

**Option B — Manual.** **New + → Web Service** → connect the repo →

| Setting | Value |
|---|---|
| Runtime | Node |
| Build command | `npm install` |
| Start command | `npm start` |
| Health check path | `/healthz` |

Then add the environment variables below.

**Environment variables (Render dashboard):**

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | from your Render Postgres (auto-wired by the Blueprint) |
| `SESSION_SECRET` | long random string |
| `GOOGLE_CLIENT_ID` | from Google Console |
| `GOOGLE_CLIENT_SECRET` | from Google Console |
| `GOOGLE_CALLBACK_URL` | `https://YOUR-APP.onrender.com/auth/google/callback` |
| `ALLOWED_EMAIL_DOMAIN` | `cardioailive.com` |
| `ALLOWED_EMAILS` | (optional) extra emails, comma-separated |
| `SALES_ENGINE_URL` | (optional) single pipeline source URL — see *Pipeline integration* |
| `PIPELINE_SOURCES` | (optional) multi-source pipeline, e.g. `sales=https://…,crm=https://…` |
| `INTEGRATION_API_KEY` | (optional) shared secret; must match the value set on each pipeline source |

After the first deploy, copy your live Render URL and add its
`/auth/google/callback` to the Authorized redirect URIs in Google Console.

> **Database:** The app uses Postgres in production. On first start it creates
> its tables automatically and seeds them once from `seed.json` — no migration
> step to run. After that, all changes persist in Postgres and survive restarts
> and redeploys. Locally, with no `DATABASE_URL`, it falls back to a JSON file so
> you can develop without installing Postgres.

> **Free tier note:** the free plan sleeps after 15 min idle and wakes in ~30s.
> The `starter` plan ($7/mo) stays always-on.

---

## What's dynamic

The backend persists every change to the database and serves it through the API.

**Wired to the live API in this build:**
- **Dashboard KPIs** — computed from real data on every load.
- **Beta Sites** — table renders from the API; Add Site / Remove persist.
- **Team Directory** — cards render from the API; Add Team Member / Remove persist.
- **Financials** — budget table and the metric cards render from the API.
- **Sales Pipeline** — deals table renders from the API; Add Deal / Remove persist.
- **Header** — shows the actual signed-in user; Logout ends the session.

**Available in the API with seed data, ready to wire** (same pattern):
`positions`, `customers`, `adopters`, `preorders`, `partnerships`, `tickets`.
The strategy, go-to-market, and playbook tabs are written content and stay static.

### Wiring another tab (the pattern)

Everything goes through `window.CardioAPI` in `app.js`:

```js
const team = await CardioAPI.list('team');
await CardioAPI.create('team', { name: 'New Hire', role: 'Engineer' });
await CardioAPI.update('team', id, { status: 'inactive' });
await CardioAPI.remove('team', id);
```

Copy the `initBetaSites()` / `renderBetaSites()` block in `app.js`, point it at a
different collection and the matching `<tbody>` in `index.html`, and that tab is
live too.

---

---

## Creating the Postgres database on Render

The Blueprint (`render.yaml`) creates it for you. If you set the web service up
manually instead, create the database yourself:

1. In Render: **New + → Postgres**.
2. Name it (e.g. `cardioai-db`), database name `cardioai_operations`, pick a
   region **matching your web service**, choose a plan (Free is fine to start).
3. Click **Create Database** and wait for it to become available.
4. Open the database page and copy the **Internal Database URL** (use Internal
   when the web service is in the same region — it's faster and free of egress).
5. In your **web service → Environment**, add a variable:
   - Key: `DATABASE_URL`
   - Value: the Internal Database URL you copied
6. Save. The web service redeploys, connects, creates its tables, and seeds them
   from `seed.json` on first run.

To inspect or reset data, connect with the **External Database URL** using `psql`
or any client:

```bash
psql "EXTERNAL_DATABASE_URL"
\dt                          -- list tables (documents, singletons, session)
SELECT collection, count(*) FROM documents GROUP BY collection;
```

To re-seed from scratch, drop the rows (`TRUNCATE documents, singletons;`) and
restart the service.

---

## Pipeline integration (live, multi-source)

The Sales Pipeline tab live-pulls deals from **one or more** upstream
services — the Cardio AI **Sales platform**, the **CRM**, or both — and shows
them merged with any deals you enter directly in the hub.

**How it works:** the hub calls each source's read-only endpoint
(`GET /api/integrations/pipeline`) server-to-server, authenticated with a shared
secret, maps every record into a deal, and merges them into `/api/deals` and the
dashboard pipeline value. Each source is cached ~60s. If a source is asleep or
unreachable it serves that source's last good data (or empty) and the others
keep working — the hub never breaks. Pulled deals show a "⚡ <source>" badge and
are read-only here (manage them in the source system); deals you add by hand stay
fully editable. The shared secret only ever lives in server environments; it
never reaches the browser.

**Setup:**

1. Generate one shared secret (used everywhere):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. **On each source** (sales platform, CRM) — expose the endpoint and set
   `INTEGRATION_API_KEY` to that secret. (Paste the block from
   `SALES_ENGINE_pipeline_endpoint.js` into the source's `server.js`, pointing
   it at that service's deals data.)
3. **On this hub** (Render → Environment) — set:
   ```
   PIPELINE_SOURCES = sales=https://cardioai-sales-platform.onrender.com,crm=https://cardio-ai-crm.onrender.com
   INTEGRATION_API_KEY = <the same shared secret>
   ```
   Format is a comma-separated list of `name=url` (the `name` is just a label
   used for badges and ids; a bare `url` also works).
4. Redeploy the hub. The Sales Pipeline tab and dashboard now show deals from
   every source, merged with manual deals.

**Single-source / back-compat:** if `PIPELINE_SOURCES` is unset, the connector
falls back to a single `SALES_ENGINE_URL`. `PIPELINE_SOURCES` takes precedence
when both are set. If neither is set, the integration simply stays off and the
Pipeline shows only manual deals — no errors.

### Avoid double-counting

The hub pulls each upstream **directly**, so each source should export only its
**own** deals:

- On the **CRM**, keep `INTEGRATION_EXPORT_EXTERNAL = false` (default) — it
  exports only its own deals, while the sales-platform deals reach the hub
  straight from the sales platform. Each deal counted once.
- If you instead switch the CRM into aggregate mode
  (`INTEGRATION_EXPORT_EXTERNAL = true`), do **not** also list the sales platform
  as a separate hub source. Pick one topology, not both.

### Configuration reference

| Where | Variable | Value |
|---|---|---|
| Hub | `PIPELINE_SOURCES` | comma-separated `name=url` list of sources |
| Hub | `INTEGRATION_API_KEY` | shared secret (32+ random chars) |
| Hub | `SALES_ENGINE_URL` | (optional) single-source fallback if `PIPELINE_SOURCES` unset |
| Hub | `INTEGRATION_CACHE_MS` | (optional) per-source cache TTL, default `60000` |
| Hub | `INTEGRATION_TIMEOUT_MS` | (optional) per-source fetch timeout, default `8000` |
| Each source | `INTEGRATION_API_KEY` | the **same** shared secret |

**Endpoint contract** (what each source must expose):

```
GET /api/integrations/pipeline
Header:  x-api-key: <INTEGRATION_API_KEY>
200 ->   { "deals": [ ... ] }   (also accepts pipeline|leads|data, or a bare array)
401 ->   wrong/missing key
```

**Field mapping** (source record → hub deal). The connector
(`salesConnector.js`) is tolerant of several field names:

| Hub deal field | Pulled from (first match wins) |
|---|---|
| `account` | `account` · `company` · `organization` · `name` |
| `contact` | `contact` · `contactName` · `champion` · `poc` |
| `stage` | `stage` · `status` (Prospecting/Lead→discovery, Demo/POC/Pilot→qualification, Proposal, Closing/Negotiation→negotiation, Closed Won/Lost) |
| `value` | `value` · `amount` · `dealValue` · `dealSize` (parses `$540K`, `1.2M`, `880000`) |
| `probability` | `probability` · `winProbability` |
| `owner` | `owner` · `rep` · `assignedTo` · `salesRep` |
| `nextAction` | `nextAction` · `nextStep` · `next` |

Every pulled deal is tagged with its `source` and given an `se_<source>_<id>`
id so it renders read-only and ids never collide across sources.

### Source health endpoint

`GET /api/integrations/sources` (signed-in session) shows each feed's live status:

```json
{
  "sources": [
    { "name": "sales", "url": "...", "ok": true,  "count": 12, "lastFetch": "...", "ageSeconds": 4, "error": null },
    { "name": "crm",   "url": "...", "ok": false, "count": 0,  "lastFetch": null,  "ageSeconds": null, "error": "fetch failed" }
  ],
  "totals": { "sources": 2, "live": 1, "deals": 12 }
}
```

`ok` is `true` (last pull succeeded), `false` (failed — see `error`), or `null`
(configured but not fetched yet). Handy for confirming both feeds are live and
for spotting a sleeping free-tier service.

### Verify

```bash
# Each source responds to the shared key:
curl -H "x-api-key: $INTEGRATION_API_KEY" \
  https://cardioai-sales-platform.onrender.com/api/integrations/pipeline
curl -H "x-api-key: $INTEGRATION_API_KEY" \
  https://cardio-ai-crm.onrender.com/api/integrations/pipeline

# After redeploy, the hub's deals include both sources plus manual deals
# (signed-in session), and the health view lists each feed:
#   https://cardioai-operations-3ejs.onrender.com/api/integrations/sources
```

A source returning 404 on `/api/integrations/pipeline` simply hasn't exposed the
endpoint yet — the other sources still work.

## API reference

All `/api/*` routes require an authenticated session.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/me` | Current user (or 401) |
| GET | `/api/dashboard` | Computed KPI summary |
| GET | `/api/financials` · PUT | Read / update financials object |
| GET | `/api/{collection}` | List items |
| GET | `/api/{collection}/:id` | One item |
| POST | `/api/{collection}` | Create (server assigns id) |
| PUT | `/api/{collection}/:id` | Update (partial) |
| DELETE | `/api/{collection}/:id` | Delete |

Collections: `betasites`, `team`, `positions`, `deals`, `customers`,
`adopters`, `preorders`, `partnerships`, `tickets`.

Auth routes: `GET /auth/google`, `GET /auth/google/callback`,
`GET /auth/logout`. Health: `GET /healthz`.

---

## Upgrade path (when you scale)

1. **Database** — Postgres is already wired (see `storage.js`). Records live in a
   `documents` table as JSONB so the flexible shapes work without per-field
   migrations; move to typed columns/an ORM (e.g. Prisma) if you want stricter
   schemas. The API surface stays identical.
2. **Roles** — add a `role` field per user (admin / sales / advisor) and gate
   write routes accordingly.
3. **Audit log** — record who changed what, since you now have real identities.
4. **Session store** — swap the file store for Redis for multi-instance scaling.

---

Built for Cardio AI Corp · internal operations tooling.
