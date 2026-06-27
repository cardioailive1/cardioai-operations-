/**
 * Cardio AI Operations Platform - Backend Server
 * --------------------------------------------------------------
 * Express + Passport (Google OAuth 2.0) + JSON persistence.
 *
 * - Employees sign in with their Google Workspace account.
 * - Access is restricted to an approved email domain (and/or an
 *   explicit allow-list) so only your team can reach the platform.
 * - The full operations dashboard is served only to signed-in users.
 * - A REST API backs the dynamic data (beta sites, team, pipeline,
 *   customers, early adopters, preorders, partnerships, support
 *   tickets, financials) and persists everything to data.json.
 *
 * Designed to deploy on Render.com as a single Node web service.
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';

// Where to send users after Google sends them back. On Render this is your
// public URL; locally it falls back to localhost.
const BASE_URL =
  process.env.BASE_URL ||
  (process.env.RENDER_EXTERNAL_URL
    ? process.env.RENDER_EXTERNAL_URL
    : `http://localhost:${PORT}`);

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL =
  process.env.GOOGLE_CALLBACK_URL || `${BASE_URL}/auth/google/callback`;

// Comma-separated list of allowed Workspace domains, e.g. "cardioailive.com"
const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAIN || 'cardioailive.com')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

// Optional explicit allow-list of individual emails (overrides domain check),
// e.g. "advisor@gmail.com,contractor@outlook.com"
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const DATA_FILE = path.join(__dirname, 'data.json');
const SEED_FILE = path.join(__dirname, 'seed.json');

// ----------------------------------------------------------------------------
// Tiny JSON "database" (file-backed). Swap for Postgres when you scale.
// ----------------------------------------------------------------------------
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Could not read data.json, falling back to seed:', err.message);
  }
  // First run (or unreadable file): seed from seed.json
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  saveData(seed);
  return seed;
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to persist data.json:', err.message);
  }
}

let db = loadData();

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ----------------------------------------------------------------------------
// Passport / Google OAuth
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// App
// ----------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // required for secure cookies behind Render's proxy

app.use(
  helmet({
    contentSecurityPolicy: false, // the dashboard uses inline styles/scripts + Google Fonts
  })
);
app.use(compression());
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new FileStore({
      path: path.join(__dirname, '.sessions'),
      retries: 1,
      logFn: () => {},
    }),
    name: 'cardioai.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 12, // 12 hours
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

// ----------------------------------------------------------------------------
// Auth routes
// ----------------------------------------------------------------------------
app.get(
  '/auth/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account',
    hd: ALLOWED_DOMAINS[0], // hint Google to the primary Workspace domain
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

// ----------------------------------------------------------------------------
// Auth guards
// ----------------------------------------------------------------------------
function ensureAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.redirect('/login');
}

function ensureApiAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ error: 'unauthenticated' });
}

// Who am I (used by the frontend to render the user chip)
app.get('/api/me', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.json({ authenticated: true, user: req.user });
  }
  return res.status(401).json({ authenticated: false });
});

// Health check for Render
app.get('/healthz', (req, res) => res.json({ ok: true, env: NODE_ENV }));

// ----------------------------------------------------------------------------
// REST API (all protected). Generic collections + computed dashboard.
// ----------------------------------------------------------------------------
const apiRouter = express.Router();
apiRouter.use(ensureApiAuth);

// Collections exposed as /api/<key>
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
};

Object.entries(COLLECTIONS).forEach(([route, { key, prefix }]) => {
  // List
  apiRouter.get(`/${route}`, (req, res) => {
    res.json(db[key] || []);
  });

  // Get one
  apiRouter.get(`/${route}/:id`, (req, res) => {
    const item = (db[key] || []).find((x) => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'not_found' });
    res.json(item);
  });

  // Create (server always assigns the id)
  apiRouter.post(`/${route}`, (req, res) => {
    if (!db[key]) db[key] = [];
    const payload = { ...req.body };
    delete payload.id;
    const item = { id: genId(prefix), ...payload };
    db[key].push(item);
    saveData(db);
    res.status(201).json(item);
  });

  // Update (partial)
  apiRouter.put(`/${route}/:id`, (req, res) => {
    const list = db[key] || [];
    const idx = list.findIndex((x) => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not_found' });
    list[idx] = { ...list[idx], ...req.body, id: req.params.id };
    saveData(db);
    res.json(list[idx]);
  });

  // Delete
  apiRouter.delete(`/${route}/:id`, (req, res) => {
    const list = db[key] || [];
    const idx = list.findIndex((x) => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not_found' });
    const [removed] = list.splice(idx, 1);
    saveData(db);
    res.json({ deleted: true, item: removed });
  });
});

// Financials (singleton object): GET + PUT
apiRouter.get('/financials', (req, res) => {
  res.json(db.financials || { metrics: {}, budget: [] });
});
apiRouter.put('/financials', (req, res) => {
  db.financials = { ...(db.financials || {}), ...req.body };
  saveData(db);
  res.json(db.financials);
});

// Computed dashboard summary
apiRouter.get('/dashboard', (req, res) => {
  const sites = db.betaSites || [];
  const liveStatuses = ['active', 'warning'];
  const liveCount = sites.filter((s) => liveStatuses.includes(s.status)).length;
  const avgHealth = sites.length
    ? Math.round(
        (sites.reduce((sum, s) => sum + (Number(s.healthScore) || 0), 0) /
          sites.length) *
          10
      ) / 10
    : 0;
  const activeUsers = sites.reduce((s, x) => s + (Number(x.activeUsers) || 0), 0);
  const casesProcessed = sites.reduce(
    (s, x) => s + (Number(x.casesProcessed) || 0),
    0
  );
  const openTickets = (db.supportTickets || []).filter(
    (t) => t.status !== 'closed'
  ).length;
  const pipelineValue = (db.deals || []).reduce(
    (s, d) => s + (Number(d.value) || 0),
    0
  );

  res.json({
    betaSitesLive: `${liveCount}/${sites.length}`,
    avgHealthScore: avgHealth,
    activeUsers,
    casesProcessed,
    openTickets,
    pipelineValue,
    openPositions: (db.openPositions || []).length,
    customers: (db.customers || []).length,
  });
});

app.use('/api', apiRouter);

// ----------------------------------------------------------------------------
// Pages
// ----------------------------------------------------------------------------
// Login page is public.
app.get('/login', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Protected static dashboard. Serve index.html only to signed-in users.
app.get('/', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// app.js (frontend logic) is only useful when logged in, but it contains no
// secrets; serve it to authenticated users.
app.get('/app.js', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.js'));
});

// Any other static assets you add to /public (images, etc.) - keep them gated.
app.use(ensureAuth, express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------------------------------
// Start
// ----------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\nCardio AI Operations Platform`);
  console.log(`  Listening on  ${BASE_URL}`);
  console.log(`  Environment   ${NODE_ENV}`);
  console.log(`  Allowed       ${ALLOWED_DOMAINS.join(', ') || '(none)'}` +
    (ALLOWED_EMAILS.length ? ` + ${ALLOWED_EMAILS.length} explicit email(s)` : ''));
  console.log(`  OAuth ready   ${Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)}\n`);
});
