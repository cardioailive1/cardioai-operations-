/**
 * Pipeline connector (multi-source) — DROP-IN REPLACEMENT
 * --------------------------------------------------------------
 * Live-pulls deals from one OR MORE upstream services and maps each record
 * into the operations platform's "deal" shape. Same public API as before
 * (`fetchSalesPipeline`, `isConfigured`) so server.js needs NO changes.
 *
 * Sources (first configured wins):
 *   1. PIPELINE_SOURCES  — comma-separated list, each "name=url" or just "url".
 *        e.g. PIPELINE_SOURCES="sales=https://cardioai-sales-platform.onrender.com,crm=https://cardio-ai-crm.onrender.com"
 *   2. SALES_ENGINE_URL  — single source (back-compat; treated as name "sales-engine").
 *
 * Each source must expose:
 *   GET /api/integrations/pipeline   Header: x-api-key: <INTEGRATION_API_KEY>
 *   -> { deals: [...] } | { pipeline|leads|data: [...] } | bare array
 *
 * All sources share INTEGRATION_API_KEY. The key never reaches the browser.
 * Results are cached briefly; if a source is asleep/unreachable, its last good
 * data (or empty) is served so the ops platform never breaks. One slow/broken
 * source does not block the others.
 *
 * Pulled deals are tagged with their `source` and given "se_"-prefixed ids so
 * the existing frontend renders them read-only alongside manual deals.
 */

const CACHE_MS = Number(process.env.INTEGRATION_CACHE_MS || 60 * 1000); // 60s
const FETCH_TIMEOUT_MS = Number(process.env.INTEGRATION_TIMEOUT_MS || 8000);

// Per-source cache: { [sourceKey]: { at, data } }
const caches = Object.create(null);
// Per-source health metadata for /api/integrations/sources
const meta = Object.create(null);

function num(v) {
  const str = String(v == null ? '' : v);
  const m = str.replace(/[,$ ]/g, '').match(/-?\d+\.?\d*/);
  let n = m ? parseFloat(m[0]) : 0;
  if (/m\b/i.test(str)) n *= 1e6;
  else if (/k\b/i.test(str)) n *= 1e3;
  else if (/b\b/i.test(str)) n *= 1e9;
  return n;
}

// Map upstream stage labels onto the ops platform's stages.
function mapStage(s) {
  const t = String(s || '').toLowerCase();
  if (/closed?.*won|won/.test(t)) return 'closed-won';
  if (/closed?.*lost|lost/.test(t)) return 'closed-lost';
  if (/closing|negoti/.test(t)) return 'negotiation';
  if (/propos/.test(t)) return 'proposal';
  if (/qualif|demo|eval|poc|pilot/.test(t)) return 'qualification';
  if (/prospect|lead|new|discov|intro/.test(t)) return 'discovery';
  return t || 'discovery';
}

// Tolerant mapper: accepts several possible field names from each source.
function mapDeal(srcName) {
  return (d, i) => {
    const rawId = d.id != null ? d.id : d._id != null ? d._id : i;
    const prob =
      d.probability != null
        ? d.probability
        : d.winProbability != null
        ? d.winProbability
        : null;
    return {
      // "se_" prefix keeps existing read-only rendering; srcName avoids id
      // collisions across sources (e.g. sales L-1 vs crm d-1).
      id: 'se_' + srcName + '_' + rawId,
      account: d.account || d.company || d.organization || d.name || 'Unknown',
      contact: d.contact || d.contactName || d.champion || d.poc || '',
      stage: mapStage(d.stage || d.status),
      value: num(
        d.value != null
          ? d.value
          : d.amount != null
          ? d.amount
          : d.dealValue != null
          ? d.dealValue
          : d.dealSize
      ),
      probability: prob != null ? num(prob) : null,
      owner: d.owner || d.rep || d.assignedTo || d.salesRep || '',
      nextAction: d.nextAction || d.nextStep || d.next || '',
      source: d.source || srcName,
      sourceLabel: srcName,
      readOnly: true,
    };
  };
}

// Parse PIPELINE_SOURCES / SALES_ENGINE_URL into [{ name, url }].
function resolveSources() {
  const raw = (process.env.PIPELINE_SOURCES || '').trim();
  if (raw) {
    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        let name, url;
        const eq = entry.indexOf('=');
        if (eq > -1) {
          name = entry.slice(0, eq).trim();
          url = entry.slice(eq + 1).trim();
        } else {
          url = entry;
          try {
            name = new URL(entry).hostname.split('.')[0];
          } catch (_) {
            name = 'source';
          }
        }
        return { name, url: url.replace(/\/+$/, '') };
      })
      .filter((s) => s.url);
  }
  const single = (process.env.SALES_ENGINE_URL || '').trim().replace(/\/+$/, '');
  return single ? [{ name: 'sales-engine', url: single }] : [];
}

async function fetchOne(src, key) {
  const cached = caches[src.name] || { at: 0, data: [] };
  if (Date.now() - cached.at < CACHE_MS && cached.data.length >= 0 && cached.at) {
    return cached.data;
  }
  const url = src.url + '/api/integrations/pipeline';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { 'x-api-key': key, accept: 'application/json' },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(src.name + ' HTTP ' + resp.status);
    const json = await resp.json();
    const arr = Array.isArray(json)
      ? json
      : json.deals || json.pipeline || json.leads || json.data || [];
    const data = arr.map(mapDeal(src.name));
    caches[src.name] = { at: Date.now(), data };
    meta[src.name] = { name: src.name, url: src.url, ok: true, count: data.length, at: Date.now(), error: null };
    return data;
  } catch (err) {
    console.warn('[pipeline-connector]', err.message, '- serving cached/empty for', src.name);
    meta[src.name] = {
      name: src.name, url: src.url, ok: false,
      count: (cached.data || []).length, at: cached.at || 0, error: err.message,
    };
    return cached.data; // last good data (possibly empty)
  } finally {
    clearTimeout(timer);
  }
}

// Public API (unchanged): returns the merged, mapped deals from all sources.
async function fetchSalesPipeline() {
  const key = process.env.INTEGRATION_API_KEY;
  const sources = resolveSources();
  if (!key || sources.length === 0) return [];
  const results = await Promise.all(sources.map((s) => fetchOne(s, key)));
  return results.flat();
}

function isConfigured() {
  return Boolean(
    process.env.INTEGRATION_API_KEY &&
      (process.env.PIPELINE_SOURCES || process.env.SALES_ENGINE_URL)
  );
}

// Health view for /api/integrations/sources. Lists every configured source with
// its last-pull result (lists configured-but-never-fetched sources too).
function sourcesStatus() {
  const now = Date.now();
  const configured = resolveSources();
  return configured.map((src) => {
    const m = meta[src.name];
    if (!m) {
      return { name: src.name, url: src.url, ok: null, count: 0, lastFetch: null, ageSeconds: null, error: null };
    }
    return {
      name: m.name,
      url: m.url,
      ok: m.ok,
      count: m.count,
      lastFetch: m.at ? new Date(m.at).toISOString() : null,
      ageSeconds: m.at ? Math.round((now - m.at) / 1000) : null,
      error: m.error || null,
    };
  });
}

module.exports = { fetchSalesPipeline, isConfigured, sourcesStatus };
