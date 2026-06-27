/**
 * ============================================================================
 *  DROP-IN for the Cardio AI SALES AUTOMATION ENGINE (cardioai-sales/server.js)
 * ============================================================================
 *  Paste this block into the sales engine's server.js, ABOVE the line that
 *  serves the frontend / starts listening (i.e. with the other app.get routes).
 *
 *  It exposes a read-only, machine-to-machine endpoint that the Operations
 *  Command Center calls to live-pull the pipeline. It is protected by a shared
 *  secret (INTEGRATION_API_KEY) — NOT by Google login — so a server can reach it.
 *
 *  1) Add to the sales engine's environment (Render dashboard + .env):
 *         INTEGRATION_API_KEY=<a long random string>
 *     Generate one:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *     Use the SAME value on the Operations Command Center.
 *
 *  2) Adjust ONE line below (marked "ADJUST") to point at wherever the sales
 *     engine keeps its deals/leads array. Common cases shown.
 * ============================================================================
 */

// --- Read-only pipeline feed for the Operations Command Center ---------------
app.get('/api/integrations/pipeline', (req, res) => {
  const expected = process.env.INTEGRATION_API_KEY;
  if (!expected) {
    return res.status(503).json({ error: 'integration_not_configured' });
  }
  const provided = req.get('x-api-key');
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'invalid_api_key' });
  }

  // ── ADJUST THIS LINE to your data source ──────────────────────────────────
  // If the sales engine persists to data.json with a `db` object:
  //     const pipeline = db.leads || db.deals || [];
  // If it uses Postgres, query your deals table and pass the rows instead.
  const pipeline = (typeof db !== 'undefined' && (db.leads || db.deals)) || [];
  // ──────────────────────────────────────────────────────────────────────────

  // Return only the fields the ops center needs (keeps internal data private).
  const safe = pipeline.map((d) => ({
    id: d.id,
    account: d.company || d.account || d.organization || d.name,
    contact: d.contact || d.contactName,
    stage: d.stage || d.status,
    value: d.value || d.amount || d.dealValue,
    probability: d.probability,
    owner: d.owner || d.rep,
    nextAction: d.nextAction || d.nextStep,
  }));

  res.json({ deals: safe, count: safe.length, generatedAt: new Date().toISOString() });
});
