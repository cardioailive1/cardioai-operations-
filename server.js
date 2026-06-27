/**
 * Cardio AI Operations Platform - Backend Server
 * --------------------------------------------------------------
 * Express + Passport (Google OAuth 2.0) + pluggable persistence.
 *
 * Persistence (see storage.js):
 *   - Postgres   when DATABASE_URL is set (production / Render)
 *   - JSON file  as a zero-setup local-dev fallback
 *
 * Deploys on Render.com as a single Node web service plus a
 * managed Postgres database.
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

const { createStore } = require('./storage');
const { fetchSalesPipeline } = require('./salesConnector');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';

const BASE_URL =
  process.env.BASE_URL ||
  (process.env.RENDER_EXTERNAL_URL
    ? process.env.RENDER_EXTERNAL_URL
    : `http://localhost:${PORT}`);

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL =
  process.env.GOOGLE_CALLBACK_URL || `${BASE_URL}/auth/google/callback`;

const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAIN || 'cardioailive.com')
  .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
const store = createStore();

// ---------------------------------------------------------------------------
// Passport / Google OAuth
// ---------------------------------------------------------------------------
function emailIsAllowed(email) {
  if (!email) return false;
  const lower = email.toLowerCase();
  if (ALLOWED_EMAILS.includes(lower)) return true;
  const domain = lower.split('@')[1] || '';
  return ALLOWED_DOMAINS.includes(domain);
}

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: GOOGLE_CALLBACK_URL,
      },
      (accessToken, refreshToken, profile, done) => {
        const email =
          profile.emails && profile.emails[0] && profile.emails[0].value;
        if (!emailIsAllowed(email)) {
          return done(null, false, { message: 'domain_not_allowed' });
        }
        const user = {
          id: profile.id,
          email,
          name: profile.displayName || email,
          picture:
            profile.photos && profile.photos[0] ? profile.photos[0].value : null,
        };
        return done(null, user);
      }
    )
  );
} else {
  console.warn(
    '\n[WARN] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set.\n' +
      '       Sign-in will not work until you add them (see .env.example).\n'
  );
}

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Session store: Postgres-backed when available, else file-backed for dev.
let sessionStore;
if (store.driver === 'postgres') {
  const pgSession = require('connect-pg-simple')(session);
  sessionStore = new pgSession({
    pool: store._pool,
    tableName: 'session',
    createTableIfMissing: true,
  });
} else {
  const FileStore = require('session-file-store')(session);
  sessionStore = new FileStore({
    path: path.join(__dirname, '.sessions'),
    retries: 1,
    logFn: () => {},
  });
}

app.use(
  session({
    store: sessionStore,
    name: 'cardioai.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 12,
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
app.get(
  '/auth/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account',
    hd: ALLOWED_DOMAINS[0],
  })
);

app.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      const reason = (info && info.message) || 'sign_in_failed';
      return res.redirect(`/login?error=${encodeURIComponent(reason)}`);
    }
    req.logIn(user, (loginErr) => {
      if (loginErr) return next(loginErr);
      return res.redirect('/');
    });
  })(req, res, next);
});

app.get('/auth/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie('cardioai.sid');
      res.redirect('/login');
    });
  });
});

// ---------------------------------------------------------------------------
// Auth guards
// ---------------------------------------------------------------------------
function ensureAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.redirect('/login');
}
function ensureApiAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ error: 'unauthenticated' });
}

app.get('/api/me', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.json({ authenticated: true, user: req.user });
  }
  return res.status(401).json({ authenticated: false });
});

app.get('/healthz', (req, res) =>
  res.json({ ok: true, env: NODE_ENV, store: store.driver })
);

// ---------------------------------------------------------------------------
// REST API (all protected). Generic collections + computed dashboard.
// ---------------------------------------------------------------------------
const apiRouter = express.Router();
apiRouter.use(ensureApiAuth);

const COLLECTIONS = {
  betasites: { key: 'betaSites', prefix: 'bs' },
  team: { key: 'team', prefix: 'tm' },
  positions: { key: 'openPositions', prefix: 'op' },
  deals: { key: 'deals', prefix: 'dl' },
  customers: { key: 'customers', prefix: 'cu' },
  adopters: { key: 'earlyAdopters', prefix: 'ea' },
  preorders: { key: 'preorders', prefix: 'po' },
  partnerships: { key: 'partnerships', prefix: 'pt' },
  tickets: { key: 'supportTickets', prefix: 'st' },
  strategicpartners: { key: 'strategicPartners', prefix: 'sp' },
  fdasubmissions: { key: 'fdaSubmissions', prefix: 'fda' },
  intlregulatory: { key: 'intlRegulatory', prefix: 'intl' },
  clinicalstudies: { key: 'clinicalStudies', prefix: 'cs' },
  safetyevents: { key: 'safetyEvents', prefix: 'sae' },
  cloudinfra: { key: 'cloudInfra', prefix: 'ci' },
  appstack: { key: 'appStack', prefix: 'asx' },
  itdatabases: { key: 'itDatabases', prefix: 'idb' },
  monitoringalerts: { key: 'monitoringAlerts', prefix: 'ma' },
  itassets: { key: 'itAssets', prefix: 'ast' },
  securitypolicies: { key: 'securityPolicies', prefix: 'pol' },
  certifications: { key: 'certifications', prefix: 'cert' },
  trainingprograms: { key: 'trainingPrograms', prefix: 'tp' },
  strategicinitiatives: { key: 'strategicInitiatives', prefix: 'si' },
  betatestingsites: { key: 'betaTestingSites', prefix: 'bt' },
  implementations: { key: 'implementations', prefix: 'bus1' },
  leadsources: { key: 'leadSources', prefix: 'bus2' },
  participants: { key: 'participants', prefix: 'ear1' },
  programbenefits: { key: 'programBenefits', prefix: 'ear2' },
  engagementactivities: { key: 'engagementActivities', prefix: 'ear3' },
  programmetrics: { key: 'programMetrics', prefix: 'ear4' },
  supportteam: { key: 'supportTeam', prefix: 'sup1' },
  ittickets: { key: 'itTickets', prefix: 'its1' },
  itescalations: { key: 'itEscalations', prefix: 'its3' },
};

function wrap(handler) {
  return (req, res) =>
    handler(req, res).catch((err) => {
      console.error('[api]', err);
      res.status(500).json({ error: 'server_error' });
    });
}

Object.entries(COLLECTIONS).forEach(([route, { key, prefix }]) => {
  apiRouter.get(`/${route}`, wrap(async (req, res) => {
    const items = await store.list(key);
    if (route === 'deals') {
      const remote = await fetchSalesPipeline();
      return res.json(items.concat(remote));
    }
    res.json(items);
  }));

  apiRouter.get(`/${route}/:id`, wrap(async (req, res) => {
    const item = await store.get(key, req.params.id);
    if (!item) return res.status(404).json({ error: 'not_found' });
    res.json(item);
  }));

  apiRouter.post(`/${route}`, wrap(async (req, res) => {
    const payload = { ...req.body };
    delete payload.id;
    const item = await store.create(key, prefix, payload);
    res.status(201).json(item);
  }));

  apiRouter.put(`/${route}/:id`, wrap(async (req, res) => {
    const updated = await store.update(key, req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'not_found' });
    res.json(updated);
  }));

  apiRouter.delete(`/${route}/:id`, wrap(async (req, res) => {
    const removed = await store.remove(key, req.params.id);
    if (!removed) return res.status(404).json({ error: 'not_found' });
    res.json({ deleted: true, item: removed });
  }));
});

apiRouter.get('/financials', wrap(async (req, res) => {
  res.json((await store.getSingleton('financials')) || { metrics: {}, budget: [] });
}));
apiRouter.put('/financials', wrap(async (req, res) => {
  res.json(await store.putSingleton('financials', req.body));
}));

apiRouter.get('/kpis', wrap(async (req, res) => {
  res.json((await store.getSingleton('kpis')) || {});
}));
apiRouter.put('/kpis', wrap(async (req, res) => {
  res.json(await store.putSingleton('kpis', req.body));
}));

apiRouter.get('/dashboard', wrap(async (req, res) => {
  const sites = await store.list('betaSites');
  const tickets = await store.list('supportTickets');
  const deals = (await store.list('deals')).concat(await fetchSalesPipeline());
  const positions = await store.list('openPositions');
  const customers = await store.list('customers');

  const liveStatuses = ['active', 'warning'];
  const liveCount = sites.filter((s) => liveStatuses.includes(s.status)).length;
  const avgHealth = sites.length
    ? Math.round(
        (sites.reduce((sum, s) => sum + (Number(s.healthScore) || 0), 0) /
          sites.length) * 10
      ) / 10
    : 0;

  res.json({
    betaSitesLive: `${liveCount}/${sites.length}`,
    avgHealthScore: avgHealth,
    activeUsers: sites.reduce((s, x) => s + (Number(x.activeUsers) || 0), 0),
    casesProcessed: sites.reduce((s, x) => s + (Number(x.casesProcessed) || 0), 0),
    openTickets: tickets.filter((t) => t.status !== 'closed').length,
    pipelineValue: deals.reduce((s, d) => s + (Number(d.value) || 0), 0),
    openPositions: positions.length,
    customers: customers.length,
  });
}));

app.use('/api', apiRouter);

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
app.get('/login', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) return res.redirect('/');
  const loginFile = path.join(__dirname, 'public', 'login.html');
  if (fs.existsSync(loginFile)) return res.sendFile(loginFile);
  // Fallback: serve a minimal sign-in page if public/login.html is missing,
  // so authentication still works even if the file wasn't deployed.
  res.type('html').send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sign in · Cardio AI Operations</title>
    <style>body{font-family:system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;
    justify-content:center;margin:0;background:linear-gradient(135deg,#0A1929,#132F4C);color:#E8F1F5}
    .card{background:#1A2F47;border:1px solid #2A4A65;border-radius:16px;padding:2.5rem;text-align:center;max-width:380px}
    h1{font-size:1.4rem;margin:0 0 .5rem}p{color:#9DB4C7;margin:0 0 1.5rem}
    a{display:inline-block;background:#fff;color:#1f2937;text-decoration:none;font-weight:600;
    padding:.85rem 1.5rem;border-radius:10px}</style></head>
    <body><div class="card"><div style="font-size:2.5rem">🫀</div>
    <h1>Cardio AI Operations</h1><p>Sign in with your company Google account.</p>
    <a href="/auth/google">Sign in with Google</a></div></body></html>`);
});

app.get('/', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/app.js', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.js'));
});

app.use(ensureAuth, express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Start (after storage is ready)
// ---------------------------------------------------------------------------
store
  .init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\nCardio AI Operations Platform`);
      console.log(`  Listening on  ${BASE_URL}`);
      console.log(`  Environment   ${NODE_ENV}`);
      console.log(`  Storage       ${store.driver}`);
      console.log(
        `  Allowed       ${ALLOWED_DOMAINS.join(', ') || '(none)'}` +
          (ALLOWED_EMAILS.length ? ` + ${ALLOWED_EMAILS.length} explicit email(s)` : '')
      );
      console.log(`  OAuth ready   ${Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)}\n`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize storage:', err);
    process.exit(1);
  });
