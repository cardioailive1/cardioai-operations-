/**
 * Sales Engine connector
 * --------------------------------------------------------------
 * Live-pulls the pipeline from the Cardio AI Sales Automation Engine
 * and maps each record into the operations platform's "deal" shape.
 *
 * - Reads SALES_ENGINE_URL + INTEGRATION_API_KEY from the environment.
 * - Calls the engine server-to-server (the key never reaches the browser).
 * - Caches results briefly so the Pipeline tab stays snappy.
 * - On any error (engine asleep/unreachable) it serves the last good
 *   cache, or an empty list — so the ops platform never breaks.
 *
 * Sales-engine deals are tagged source:"sales-engine" and given ids
 * prefixed "se_" so the frontend can render them read-only alongside
 * the manually-entered deals.
 */

const CACHE_MS = 60 * 1000; // 60-second cache
let cache = { at: 0, data: [] };

function num(v) {
  const str = String(v == null ? '' : v);
  const m = str.replace(/[,$ ]/g, '').match(/-?\d+\.?\d*/);
  let n = m ? parseFloat(m[0]) : 0;
  if (/m\b/i.test(str)) n *= 1e6; else if (/k\b/i.test(str)) n *= 1e3;
  return n;
}

// Map the sales engine's stage labels onto the ops platform's stages.
function mapStage(s) {
  const t = String(s || '').toLowerCase();
  if (/closed?.*won|won/.test(t)) return 'closed-won';
  if (/closed?.*lost|lost/.test(t)) return 'closed-lost';
  if (/closing|negoti/.test(t)) return 'negotiation';
  if (/propos/.test(t)) return 'proposal';
  if (/qualif/.test(t)) return 'qualification';
  if (/prospect|lead|new|discov/.test(t)) return 'discovery';
  return t || 'discovery';
}

// Tolerant mapper: accepts several possible field names from the engine.
function mapDeal(d, i) {
  return {
    id: 'se_' + (d.id != null ? d.id : (d._id != null ? d._id : i)),
    account: d.account || d.company || d.organization || d.name || 'Unknown',
    contact: d.contact || d.contactName || d.champion || d.poc || '',
    stage: mapStage(d.stage || d.status),
    value: num(d.value != null ? d.value : (d.amount != null ? d.amount : (d.dealValue != null ? d.dealValue : d.dealSize))),
    probability: (d.probability != null || d.winProbability != null)
      ? num(d.probability != null ? d.probability : d.winProbability) : undefined,
    owner: d.owner || d.rep || d.assignedTo || d.salesRep || '',
    nextAction: d.nextAction || d.nextStep || d.next || d.nextStepDate || '',
    source: 'sales-engine',
  };
}

async function fetchSalesPipeline() {
  const url = process.env.SALES_ENGINE_URL;
  const key = process.env.INTEGRATION_API_KEY;
  if (!url || !key) return []; // integration not configured

  if (Date.now() - cache.at < CACHE_MS) return cache.data;

  const endpoint = url.replace(/\/+$/, '') + '/api/integrations/pipeline';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(endpoint, {
      headers: { 'x-api-key': key, Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error('sales engine responded ' + resp.status);

    const json = await resp.json();
    const arr = Array.isArray(json)
      ? json
      : (json.deals || json.pipeline || json.leads || json.data || []);

    cache = { at: Date.now(), data: arr.map(mapDeal) };
    return cache.data;
  } catch (err) {
    console.warn('[sales-connector]', err.message, '- serving cached pipeline');
    return cache.data; // last good data (possibly empty)
  }
}

function isConfigured() {
  return Boolean(process.env.SALES_ENGINE_URL && process.env.INTEGRATION_API_KEY);
}

module.exports = { fetchSalesPipeline, isConfigured };
