/**
 * Cardio AI Operations Platform - frontend runtime
 * --------------------------------------------------------------
 * Progressive enhancement layer that:
 *   1. Confirms the signed-in user and fills the header chip.
 *   2. Wires the Logout button to the server session.
 *   3. Hydrates dashboard KPIs from the live API.
 *   4. Renders the Beta Sites table from the API with add/remove.
 *   5. Exposes window.CardioAPI so any other module can read/write
 *      the same persistent data (team, deals, customers, etc.).
 *
 * No secrets live here. All data comes from the authenticated
 * REST API exposed by server.js.
 */
(function () {
  'use strict';

  // ---- Minimal API client -------------------------------------------------
  async function api(method, pathSuffix, body) {
    const res = await fetch('/api' + pathSuffix, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    if (res.status === 401) {
      window.location.href = '/login';
      throw new Error('unauthenticated');
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error || ''; } catch (_) {}
      throw new Error(detail || `Request failed (${res.status})`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  const CardioAPI = {
    me: () => api('GET', '/me'),
    dashboard: () => api('GET', '/dashboard'),
    list: (c) => api('GET', '/' + c),
    get: (c, id) => api('GET', `/${c}/${id}`),
    create: (c, data) => api('POST', '/' + c, data),
    update: (c, id, data) => api('PUT', `/${c}/${id}`, data),
    remove: (c, id) => api('DELETE', `/${c}/${id}`),
    financials: () => api('GET', '/financials'),
    saveFinancials: (data) => api('PUT', '/financials', data),
    kpis: () => api('GET', '/kpis'),
    saveKpis: (data) => api('PUT', '/kpis', data),
  };
  window.CardioAPI = CardioAPI;

  // ---- Helpers ------------------------------------------------------------
  function initials(name) {
    return (name || '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0].toUpperCase())
      .join('') || 'CA';
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function healthClass(score) {
    if (score >= 85) return 'excellent';
    if (score >= 70) return 'good';
    return 'warning';
  }

  function statusBadge(status) {
    const map = {
      active: { cls: 'active', label: 'Active' },
      warning: { cls: 'warning', label: 'Warning' },
      setup: { cls: 'pending', label: 'In Setup' },
      pending: { cls: 'pending', label: 'Pending' },
    };
    const s = map[status] || { cls: 'active', label: status || 'Active' };
    return `<span class="status-badge ${s.cls}"><span class="status-indicator"></span> ${s.label}</span>`;
  }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---- 1 & 2. User chip + logout -----------------------------------------
  async function initUser() {
    try {
      const { user } = await CardioAPI.me();
      const nameEl = document.getElementById('user-name');
      const roleEl = document.getElementById('user-role');
      const avatarEl = document.getElementById('user-avatar');
      if (nameEl) nameEl.textContent = user.name || user.email;
      if (roleEl) roleEl.textContent = user.email || 'Team member';
      if (avatarEl) {
        if (user.picture) {
          avatarEl.style.backgroundImage = `url(${user.picture})`;
          avatarEl.style.backgroundSize = 'cover';
          avatarEl.style.backgroundPosition = 'center';
          avatarEl.textContent = '';
        } else {
          avatarEl.textContent = initials(user.name || user.email);
        }
      }
    } catch (e) {
      // /api/me 401 already redirects to /login
      console.warn('Could not load user:', e.message);
    }

    const logoutBtn = document.getElementById('logout-button');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        window.location.href = '/auth/logout';
      });
    }
  }

  // ---- 3. Dashboard KPIs --------------------------------------------------
  async function initDashboard() {
    try {
      const d = await CardioAPI.dashboard();
      document.querySelectorAll('[data-bind]').forEach((el) => {
        const key = el.getAttribute('data-bind');
        if (d[key] === undefined || d[key] === null) return;
        let v = d[key];
        if (key === 'avgHealthScore') v = Math.round(v);
        el.textContent = v;
      });
    } catch (e) {
      console.warn('Dashboard hydrate failed:', e.message);
    }
  }

  // ---- 4. Beta Sites table (live render + add + remove) -------------------
  let betaSitesCache = [];

  function betaSiteRow(site) {
    const progress = Math.max(0, Math.min(100, Number(site.healthScore) || 0));
    return `
      <tr data-id="${esc(site.id)}">
        <td><strong>${esc(site.name)}</strong></td>
        <td>${esc(site.location)}</td>
        <td>${statusBadge(site.status)}</td>
        <td>
          <div class="health-score">
            <div class="health-circle ${healthClass(site.healthScore)}">${esc(site.healthScore)}</div>
          </div>
        </td>
        <td>${fmtDate(site.goLiveDate)}</td>
        <td>${esc((site.activeUsers ?? 0).toLocaleString ? Number(site.activeUsers).toLocaleString() : site.activeUsers)}</td>
        <td>${Number(site.casesProcessed || 0).toLocaleString()}</td>
        <td>
          <div class="progress-bar"><div class="progress-fill" style="width: ${progress}%;"></div></div>
        </td>
        <td style="white-space:nowrap;">
          <button class="bs-remove" data-id="${esc(site.id)}" title="Remove site"
            style="background:rgba(232,57,70,0.15);color:#ff8a80;border:1px solid rgba(232,57,70,0.4);border-radius:6px;padding:0.3rem 0.6rem;cursor:pointer;font-size:0.8rem;">✕</button>
        </td>
      </tr>`;
  }

  function setMiniStat(sectionId, labelRe, value) {
    const section = document.getElementById(sectionId);
    if (!section) return;
    const labelEl = Array.from(section.querySelectorAll('.mini-stat-label'))
      .find((t) => labelRe.test(t.textContent || ''));
    if (!labelEl) return;
    const box = labelEl.closest('.mini-stat') || labelEl.parentElement;
    const valEl = box && box.querySelector('.mini-stat-value');
    if (valEl) valEl.textContent = value;
  }

  function updateBetaSiteStats() {
    const sites = betaSitesCache || [];
    setMiniStat('beta-sites-section', /total beta sites/i, sites.length);
    setMiniStat('beta-sites-section', /active sites/i, sites.filter((s) => s.status === 'active').length);
    setMiniStat('beta-sites-section', /in setup/i, sites.filter((s) => s.status === 'setup').length);
    setMiniStat('beta-sites-section', /pending/i, sites.filter((s) => s.status === 'warning' || s.status === 'pending').length);
  }

  function renderBetaSites() {
    const tbody = document.getElementById('beta-sites-tbody');
    // Dashboard preview table (read-only, no actions column)
    const preview = document.getElementById('beta-sites-preview-tbody');
    if (preview) {
      if (!betaSitesCache.length) {
        preview.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:1.5rem;">No beta sites yet.</td></tr>`;
      } else {
        preview.innerHTML = betaSitesCache.map((site) => {
          const progress = Math.max(0, Math.min(100, Number(site.healthScore) || 0));
          return `
            <tr>
              <td><strong>${esc(site.name)}</strong></td>
              <td>${esc(site.location)}</td>
              <td>${statusBadge(site.status)}</td>
              <td><div class="health-score"><div class="health-circle ${healthClass(site.healthScore)}">${esc(site.healthScore)}</div></div></td>
              <td>${fmtDate(site.goLiveDate)}</td>
              <td>${Number(site.activeUsers || 0).toLocaleString()}</td>
              <td>${Number(site.casesProcessed || 0).toLocaleString()}</td>
              <td><div class="progress-bar"><div class="progress-fill" style="width:${progress}%;"></div></div></td>
            </tr>`;
        }).join('');
      }
    }
    if (!tbody) return;
    updateBetaSiteStats();
    if (!betaSitesCache.length) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:2rem;">No beta sites yet. Use “Add Site” to create one.</td></tr>`;
      return;
    }
    tbody.innerHTML = betaSitesCache.map(betaSiteRow).join('');
    tbody.querySelectorAll('.bs-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const site = betaSitesCache.find((s) => s.id === id);
        if (!confirm(`Remove ${site ? site.name : 'this site'}? This cannot be undone.`)) return;
        try {
          await CardioAPI.remove('betasites', id);
          betaSitesCache = betaSitesCache.filter((s) => s.id !== id);
          renderBetaSites();
          initDashboard();
        } catch (e) {
          alert('Could not remove site: ' + e.message);
        }
      });
    });
  }

  async function initBetaSites() {
    const tbody = document.getElementById('beta-sites-tbody');
    if (!tbody) return;
    try {
      betaSitesCache = await CardioAPI.list('betasites');
      renderBetaSites();
      wireAddSiteButton();
    } catch (e) {
      console.warn('Beta sites load failed:', e.message);
    }
  }

  function wireAddSiteButton() {
    // Attach to any button in the Beta Sites section whose label mentions "Add Site".
    const section = document.getElementById('beta-sites-section');
    if (!section) return;
    const candidates = Array.from(section.querySelectorAll('button, .btn'));
    const addBtn = candidates.find((b) => /add\s*site|new\s*site|add\s*beta/i.test(b.textContent || ''));
    const handler = (ev) => { ev.preventDefault(); openAddSiteModal(); };
    if (addBtn) {
      addBtn.replaceWith(addBtn.cloneNode(true)); // strip any stale alert() handler
      const fresh = Array.from(section.querySelectorAll('button, .btn'))
        .find((b) => /add\s*site|new\s*site|add\s*beta/i.test(b.textContent || ''));
      if (fresh) fresh.addEventListener('click', handler);
    }
  }

  function openAddSiteModal() {
    const wrap = document.createElement('div');
    wrap.className = 'modal-overlay';
    wrap.style.cssText = 'display:flex;position:fixed;inset:0;background:rgba(5,15,28,0.7);z-index:100000;align-items:center;justify-content:center;';
    wrap.innerHTML = `
      <div class="modal" style="background:linear-gradient(135deg,#1A2F47,#264159);border:1px solid #2A4A65;border-radius:16px;max-width:520px;width:92%;padding:1.75rem;color:#E8F1F5;box-shadow:0 24px 70px rgba(0,0,0,0.55);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem;">
          <h3 style="margin:0;font-size:1.25rem;">Add Beta Site</h3>
          <button id="bs-close" style="background:none;border:none;color:#9DB4C7;font-size:1.4rem;cursor:pointer;">✕</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.9rem;">
          ${field('bs-name','Hospital name','text','',true)}
          ${field('bs-location','Location','text','City, ST')}
          ${selectField('bs-status','Status',[['active','Active'],['warning','Warning'],['setup','In Setup']])}
          ${field('bs-health','Health score (0-100)','number','80')}
          ${field('bs-golive','Go-live date','date','')}
          ${field('bs-users','Active users','number','0')}
          ${field('bs-cases','Cases processed','number','0')}
        </div>
        <div id="bs-error" style="color:#ff8a80;font-size:0.85rem;margin-top:0.75rem;min-height:1.1em;"></div>
        <div style="display:flex;gap:0.75rem;margin-top:1.25rem;">
          <button id="bs-save" style="flex:1;background:linear-gradient(135deg,#1E5A8E,#2B7BC4);color:#fff;border:none;border-radius:10px;padding:0.8rem;font-weight:600;cursor:pointer;">Save site</button>
          <button id="bs-cancel" style="background:#22384f;color:#cfe0ec;border:1px solid #2A4A65;border-radius:10px;padding:0.8rem 1.1rem;cursor:pointer;">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const close = () => wrap.remove();
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    wrap.querySelector('#bs-close').addEventListener('click', close);
    wrap.querySelector('#bs-cancel').addEventListener('click', close);

    wrap.querySelector('#bs-save').addEventListener('click', async () => {
      const errEl = wrap.querySelector('#bs-error');
      const name = wrap.querySelector('#bs-name').value.trim();
      if (!name) { errEl.textContent = 'Hospital name is required.'; return; }
      const payload = {
        name,
        location: wrap.querySelector('#bs-location').value.trim(),
        status: wrap.querySelector('#bs-status').value,
        healthScore: Number(wrap.querySelector('#bs-health').value) || 0,
        goLiveDate: wrap.querySelector('#bs-golive').value || null,
        activeUsers: Number(wrap.querySelector('#bs-users').value) || 0,
        casesProcessed: Number(wrap.querySelector('#bs-cases').value) || 0,
      };
      try {
        const created = await CardioAPI.create('betasites', payload);
        betaSitesCache.push(created);
        renderBetaSites();
        initDashboard();
        close();
      } catch (e) {
        errEl.textContent = 'Could not save: ' + e.message;
      }
    });
  }

  function field(id, label, type, placeholder, full) {
    return `
      <label style="display:flex;flex-direction:column;gap:0.3rem;font-size:0.8rem;color:#9DB4C7;${full ? 'grid-column:1 / -1;' : ''}">
        ${label}
        <input id="${id}" type="${type}" placeholder="${placeholder || ''}"
          style="background:#0A1929;border:1px solid #2A4A65;border-radius:8px;padding:0.6rem;color:#E8F1F5;font-family:inherit;">
      </label>`;
  }
  function selectField(id, label, opts) {
    return `
      <label style="display:flex;flex-direction:column;gap:0.3rem;font-size:0.8rem;color:#9DB4C7;">
        ${label}
        <select id="${id}" style="background:#0A1929;border:1px solid #2A4A65;border-radius:8px;padding:0.6rem;color:#E8F1F5;font-family:inherit;">
          ${opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
        </select>
      </label>`;
  }

  // ---- Currency helpers ---------------------------------------------------
  function money(n) {
    const v = Number(n) || 0;
    return '$' + v.toLocaleString('en-US');
  }
  function moneyShort(n) {
    const v = Number(n) || 0;
    if (Math.abs(v) >= 1e6) return '$' + (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (Math.abs(v) >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
    return '$' + v;
  }

  const AVATAR_GRADIENTS = [
    'linear-gradient(135deg, var(--primary) 0%, var(--info) 100%)',
    'linear-gradient(135deg, var(--success) 0%, var(--info) 100%)',
    'linear-gradient(135deg, var(--info) 0%, var(--primary) 100%)',
    'linear-gradient(135deg, var(--warning) 0%, var(--accent) 100%)',
    'linear-gradient(135deg, var(--accent) 0%, var(--primary) 100%)',
    'linear-gradient(135deg, var(--primary-light) 0%, var(--success) 100%)',
  ];

  // Find a button in a section by text; if missing, create one in the header.
  function ensureActionButton(sectionId, matchRe, label, onClick) {
    const section = document.getElementById(sectionId);
    if (!section) return;
    let btn = Array.from(section.querySelectorAll('button, .btn'))
      .find((b) => matchRe.test(b.textContent || ''));
    if (btn) {
      const clone = btn.cloneNode(true); // drop stale alert() handlers
      btn.replaceWith(clone);
      btn = clone;
    } else {
      btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = label;
      const header = section.querySelector('.section-header') || section.firstElementChild;
      if (header) header.appendChild(btn);
      else section.prepend(btn);
    }
    btn.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
  }

  // ---- 5. Team Directory --------------------------------------------------
  let teamCache = [];

  function teamCard(m, i) {
    const grad = AVATAR_GRADIENTS[i % AVATAR_GRADIENTS.length];
    return `
      <div class="team-card" data-id="${esc(m.id)}" style="position:relative;">
        <button class="tm-remove" data-id="${esc(m.id)}" title="Remove"
          style="position:absolute;top:8px;right:8px;background:rgba(232,57,70,0.15);color:#ff8a80;border:1px solid rgba(232,57,70,0.4);border-radius:6px;width:24px;height:24px;cursor:pointer;font-size:0.75rem;line-height:1;">✕</button>
        <div class="team-avatar" style="background:${grad};">${esc(initials(m.name))}</div>
        <div class="team-name">${esc(m.name)}</div>
        <div class="team-role">${esc(m.role || '')}</div>
        <div class="team-department">${esc(m.department || '')}</div>
      </div>`;
  }

  function renderTeam() {
    const grid = document.getElementById('team-grid');
    if (!grid) return;
    if (!teamCache.length) {
      grid.innerHTML = `
        <div class="team-card">
          <div class="team-avatar" style="background:linear-gradient(135deg,var(--text-muted),var(--border));">TBD</div>
          <div class="team-name">TBD</div>
          <div class="team-role">To be assigned</div>
          <div class="team-department">Add a team member to populate</div>
        </div>`;
      return;
    }
    grid.innerHTML = teamCache.map(teamCard).join('');
    grid.querySelectorAll('.tm-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const m = teamCache.find((x) => x.id === id);
        if (!confirm(`Remove ${m ? m.name : 'this member'}?`)) return;
        try {
          await CardioAPI.remove('team', id);
          teamCache = teamCache.filter((x) => x.id !== id);
          renderTeam();
        } catch (e) { alert('Could not remove: ' + e.message); }
      });
    });
  }

  async function initTeam() {
    const grid = document.getElementById('team-grid');
    if (!grid) return;
    try {
      teamCache = await CardioAPI.list('team');
      renderTeam();
      ensureActionButton('team-section', /add\s*team|add\s*member/i, '➕ Add Team Member', openAddTeamModal);
    } catch (e) { console.warn('Team load failed:', e.message); }
  }

  function openAddTeamModal() {
    modal('Add Team Member', `
      ${field('tm-name','Full name','text','',true)}
      ${field('tm-role','Role / title','text','')}
      ${field('tm-dept','Department','text','')}
      ${field('tm-email','Email','email','')}
    `, async (root, close, err) => {
      const name = root.querySelector('#tm-name').value.trim();
      if (!name) { err('Name is required.'); return; }
      const payload = {
        name,
        role: root.querySelector('#tm-role').value.trim(),
        department: root.querySelector('#tm-dept').value.trim(),
        email: root.querySelector('#tm-email').value.trim(),
        status: 'active',
      };
      const created = await CardioAPI.create('team', payload);
      teamCache.push(created);
      renderTeam();
      close();
    });
  }

  // ---- 6. Financials ------------------------------------------------------
  async function initFinancials() {
    const tbody = document.getElementById('budget-tbody');
    const hasFinCards = document.querySelector('[data-fin]');
    if (!tbody && !hasFinCards) return;
    try {
      const fin = await CardioAPI.financials();
      // Metric cards
      const m = fin.metrics || {};
      document.querySelectorAll('[data-fin]').forEach((el) => {
        const key = el.getAttribute('data-fin');
        if (m[key] === undefined || m[key] === null) return;
        if (key === 'grossMargin') el.textContent = m[key] + '%';
        else el.textContent = moneyShort(m[key]);
      });
      // Budget table
      if (tbody) {
        const rows = fin.budget || [];
        tbody.innerHTML = rows.map((b) => {
          const remaining = (Number(b.allocated) || 0) - (Number(b.spent) || 0);
          const pct = b.allocated ? Math.round((b.spent / b.allocated) * 100) : 0;
          return `
            <tr>
              <td><strong>${esc(b.department)}</strong></td>
              <td>${money(b.allocated)}</td>
              <td>${money(b.spent)}</td>
              <td>${money(remaining)}</td>
              <td>
                <div class="progress-bar"><div class="progress-fill" style="width:${Math.min(100, pct)}%;"></div></div>
                <span style="font-size:0.8rem;color:var(--text-muted);">${pct}%</span>
              </td>
              <td>${esc(b.headcount != null ? b.headcount : '—')}</td>
            </tr>`;
        }).join('');
      }
    } catch (e) { console.warn('Financials load failed:', e.message); }
  }

  // ---- 7. Sales Pipeline --------------------------------------------------
  let dealsCache = [];

  const STAGE_LABELS = {
    discovery: 'Discovery', qualification: 'Qualification',
    proposal: 'Proposal', negotiation: 'Negotiation',
    'closed-won': 'Closed Won', 'closed-lost': 'Closed Lost',
  };

  function dealRow(d) {
    const stage = STAGE_LABELS[d.stage] || d.stage || '';
    const prob = d.probability != null ? d.probability + '%' : '—';
    const synced = d.readOnly === true || !!d.sourceLabel || (typeof d.id === 'string' && d.id.indexOf('se_') === 0);
    const label = d.sourceLabel || d.source || 'Sales Engine';
    const badge = synced
      ? ` <span title="Synced live from ${esc(label)}" style="font-size:0.65rem;background:rgba(43,123,196,0.18);color:#7fb3e0;border:1px solid rgba(43,123,196,0.4);border-radius:4px;padding:0.05rem 0.35rem;vertical-align:middle;text-transform:capitalize;">⚡ ${esc(label)}</span>`
      : '';
    const action = synced
      ? '<span style="color:var(--text-muted);font-size:0.8rem;" title="Managed in the source system">🔒</span>'
      : `<button class="dl-remove" data-id="${esc(d.id)}" title="Remove"
            style="background:rgba(232,57,70,0.15);color:#ff8a80;border:1px solid rgba(232,57,70,0.4);border-radius:6px;padding:0.3rem 0.6rem;cursor:pointer;font-size:0.8rem;">✕</button>`;
    return `
      <tr data-id="${esc(d.id)}">
        <td><strong>${esc(d.account)}</strong>${badge}</td>
        <td>${esc(d.contact || '—')}</td>
        <td><span class="status-badge active"><span class="status-indicator"></span> ${esc(stage)}</span></td>
        <td>${money(d.value)}</td>
        <td>${esc(prob)}</td>
        <td>${esc(d.nextAction || '—')}</td>
        <td>${esc(d.owner || '—')}</td>
        <td style="white-space:nowrap;">${action}</td>
      </tr>`;
  }

  function renderPipeline() {
    const tbody = document.getElementById('pipeline-tbody');
    if (!tbody) return;
    if (!dealsCache.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:2rem;">No deals yet. Use “Add Deal”.</td></tr>`;
      return;
    }
    tbody.innerHTML = dealsCache.map(dealRow).join('');
    tbody.querySelectorAll('.dl-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const d = dealsCache.find((x) => x.id === id);
        if (!confirm(`Remove the ${d ? d.account : 'this'} deal?`)) return;
        try {
          await CardioAPI.remove('deals', id);
          dealsCache = dealsCache.filter((x) => x.id !== id);
          renderPipeline();
          initDashboard();
        } catch (e) { alert('Could not remove: ' + e.message); }
      });
    });
  }

  async function initPipeline() {
    const tbody = document.getElementById('pipeline-tbody');
    if (!tbody) return;
    try {
      dealsCache = await CardioAPI.list('deals');
      renderPipeline();
      ensureActionButton('business-development-section', /add\s*deal|add\s*opportunity|new\s*deal/i, '➕ Add Deal', openAddDealModal);
    } catch (e) { console.warn('Pipeline load failed:', e.message); }
  }

  function openAddDealModal() {
    modal('Add Deal', `
      ${field('dl-account','Organization','text','',true)}
      ${field('dl-contact','Contact','text','')}
      ${selectField('dl-stage','Stage',[['discovery','Discovery'],['qualification','Qualification'],['proposal','Proposal'],['negotiation','Negotiation'],['closed-won','Closed Won'],['closed-lost','Closed Lost']])}
      ${field('dl-value','Value (USD)','number','0')}
      ${field('dl-prob','Probability (%)','number','50')}
      ${field('dl-owner','Owner','text','')}
      ${field('dl-next','Next action','text','')}
    `, async (root, close, err) => {
      const account = root.querySelector('#dl-account').value.trim();
      if (!account) { err('Organization is required.'); return; }
      const payload = {
        account,
        contact: root.querySelector('#dl-contact').value.trim(),
        stage: root.querySelector('#dl-stage').value,
        value: Number(root.querySelector('#dl-value').value) || 0,
        probability: Number(root.querySelector('#dl-prob').value) || 0,
        owner: root.querySelector('#dl-owner').value.trim(),
        nextAction: root.querySelector('#dl-next').value.trim(),
      };
      const created = await CardioAPI.create('deals', payload);
      dealsCache.push(created);
      renderPipeline();
      initDashboard();
      close();
    });
  }

  // ---- 8. Customers ------------------------------------------------------
  let customersCache = [];
  function healthLabel(h) {
    return { healthy: ['active', 'Healthy'], 'at-risk': ['warning', 'At Risk'], churned: ['pending', 'Churned'] }[h] || ['active', h || '—'];
  }
  function removeBtn(cls, id, title) {
    return `<button class="${cls}" data-id="${esc(id)}" title="${title}" style="margin-left:0.5rem;background:rgba(232,57,70,0.15);color:#ff8a80;border:1px solid rgba(232,57,70,0.4);border-radius:6px;padding:0.25rem 0.5rem;cursor:pointer;font-size:0.75rem;">✕</button>`;
  }
  function wireRemove(tbody, cls, collection, cache, rerender) {
    tbody.querySelectorAll('.' + cls).forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (!confirm('Remove this record?')) return;
        try {
          await CardioAPI.remove(collection, id);
          rerender(cache.filter((x) => x.id !== id));
        } catch (e) { alert('Could not remove: ' + e.message); }
      });
    });
  }

  function renderCustomers() {
    const tbody = document.getElementById('customers-tbody');
    if (!tbody) return;
    if (!customersCache.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:1.5rem;">No customers yet.</td></tr>`;
    } else {
      tbody.innerHTML = customersCache.map((c) => {
        const [cls, lbl] = healthLabel(c.health);
        return `<tr data-id="${esc(c.id)}">
          <td><strong>${esc(c.name)}</strong></td>
          <td><div class="health-score"><div class="health-circle ${healthClass(c.healthScore)}">${esc(c.healthScore ?? '—')}</div></div></td>
          <td>${c.userAdoption != null ? esc(c.userAdoption) + '%' : '—'}</td>
          <td>${esc(c.casesPerMonth ?? '—')}</td>
          <td>${fmtDate(c.lastCheckin)}</td>
          <td>${esc(c.csm || '—')}</td>
          <td><span class="status-badge ${cls}"><span class="status-indicator"></span> ${esc(lbl)}</span>${removeBtn('cu-remove', c.id, 'Remove')}</td>
        </tr>`;
      }).join('');
      wireRemove(tbody, 'cu-remove', 'customers', customersCache, (next) => { customersCache = next; renderCustomers(); initCustomerStats(); });
    }
  }
  function initCustomerStats() {
    setCardValue('customers-section', /total customers/i, customersCache.length);
    const avg = customersCache.length ? Math.round(customersCache.reduce((s, c) => s + (Number(c.healthScore) || 0), 0) / customersCache.length) : '—';
    setCardValue('customers-section', /avg health/i, avg);
  }
  async function initCustomers() {
    if (!document.getElementById('customers-tbody')) return;
    try {
      customersCache = await CardioAPI.list('customers');
      renderCustomers(); initCustomerStats();
      ensureActionButton('customers-section', /add\s*customer/i, '➕ Add Customer', openAddCustomerModal);
    } catch (e) { console.warn('Customers load failed:', e.message); }
  }
  function openAddCustomerModal() {
    modal('Add Customer', `
      ${field('cu-name','Customer','text','',true)}
      ${selectField('cu-health','Health',[['healthy','Healthy'],['at-risk','At Risk'],['churned','Churned']])}
      ${field('cu-score','Health score','number','80')}
      ${field('cu-adopt','User adoption (%)','number','0')}
      ${field('cu-cases','Cases / month','number','0')}
      ${field('cu-csm','CSM assigned','text','')}
    `, async (root, close, err) => {
      const name = root.querySelector('#cu-name').value.trim();
      if (!name) { err('Customer name is required.'); return; }
      const created = await CardioAPI.create('customers', {
        name, health: root.querySelector('#cu-health').value,
        healthScore: Number(root.querySelector('#cu-score').value) || 0,
        userAdoption: Number(root.querySelector('#cu-adopt').value) || 0,
        casesPerMonth: Number(root.querySelector('#cu-cases').value) || 0,
        csm: root.querySelector('#cu-csm').value.trim(),
      });
      customersCache.push(created); renderCustomers(); initCustomerStats(); close();
    });
  }

  // ---- 9. Support tickets ------------------------------------------------
  let ticketsCache = [];
  function ticketStatus(s) {
    return { open: ['pending', 'Open'], 'in-progress': ['warning', 'In Progress'], closed: ['active', 'Closed'] }[s] || ['pending', s || 'Open'];
  }
  function renderTickets() {
    const tbody = document.getElementById('tickets-tbody');
    if (!tbody) return;
    if (!ticketsCache.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:1.5rem;">No tickets.</td></tr>`;
    } else {
      tbody.innerHTML = ticketsCache.map((t) => {
        const [cls, lbl] = ticketStatus(t.status);
        return `<tr data-id="${esc(t.id)}">
          <td><strong>${esc((t.id || '').toUpperCase())}</strong></td>
          <td>${esc(t.site || '—')}</td>
          <td>${esc(t.subject || '—')}</td>
          <td>${esc(t.priority || '—')}</td>
          <td><span class="status-badge ${cls}"><span class="status-indicator"></span> ${esc(lbl)}</span></td>
          <td>${esc(t.assignee || '—')}</td>
          <td>${fmtDate(t.created)}</td>
          <td>${esc(t.sla || '—')}${removeBtn('st-remove', t.id, 'Remove')}</td>
        </tr>`;
      }).join('');
      wireRemove(tbody, 'st-remove', 'tickets', ticketsCache, (next) => { ticketsCache = next; renderTickets(); initTicketStats(); });
    }
  }
  function initTicketStats() {
    setCardValue('support-section', /open tickets/i, ticketsCache.filter((t) => t.status !== 'closed').length);
  }
  async function initSupport() {
    if (!document.getElementById('tickets-tbody')) return;
    try {
      ticketsCache = await CardioAPI.list('tickets');
      renderTickets(); initTicketStats();
      ensureActionButton('support-section', /new\s*ticket|add\s*ticket|create\s*ticket/i, '➕ New Ticket', openAddTicketModal);
    } catch (e) { console.warn('Support load failed:', e.message); }
  }
  function openAddTicketModal() {
    modal('New Support Ticket', `
      ${field('st-subject','Issue','text','',true)}
      ${field('st-site','Customer / site','text','')}
      ${selectField('st-priority','Priority',[['low','Low'],['medium','Medium'],['high','High'],['critical','Critical']])}
      ${selectField('st-status','Status',[['open','Open'],['in-progress','In Progress'],['closed','Closed']])}
      ${field('st-assignee','Assigned to','text','')}
    `, async (root, close, err) => {
      const subject = root.querySelector('#st-subject').value.trim();
      if (!subject) { err('Issue is required.'); return; }
      const created = await CardioAPI.create('tickets', {
        subject, site: root.querySelector('#st-site').value.trim(),
        priority: root.querySelector('#st-priority').value,
        status: root.querySelector('#st-status').value,
        assignee: root.querySelector('#st-assignee').value.trim(),
        created: new Date().toISOString().slice(0, 10), sla: 'On track',
      });
      ticketsCache.push(created); renderTickets(); initTicketStats(); initDashboard(); close();
    });
  }

  // ---- 10. Open Positions ------------------------------------------------
  let positionsCache = [];
  function renderPositions() {
    const tbody = document.getElementById('positions-tbody');
    if (!tbody) return;
    if (!positionsCache.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:1.5rem;">No open positions.</td></tr>`;
    } else {
      tbody.innerHTML = positionsCache.map((p) => `
        <tr data-id="${esc(p.id)}">
          <td><strong>${esc(p.title)}</strong></td>
          <td>${esc(p.department || '—')}</td>
          <td>${esc(p.level || '—')}</td>
          <td><span class="status-badge active"><span class="status-indicator"></span> ${esc(p.status === 'open' ? 'Active' : p.status || 'Active')}</span></td>
          <td>${esc(p.applications ?? 0)}${removeBtn('op-remove', p.id, 'Remove')}</td>
          <td>${fmtDate(p.postedDate)}</td>
        </tr>`).join('');
      wireRemove(tbody, 'op-remove', 'positions', positionsCache, (next) => { positionsCache = next; renderPositions(); });
    }
  }
  async function initPositions() {
    if (!document.getElementById('positions-tbody')) return;
    try {
      positionsCache = await CardioAPI.list('positions');
      renderPositions();
      ensureActionButton('team-section', /add\s*position|post\s*job|new\s*position|add\s*role/i, '➕ Add Position', openAddPositionModal);
    } catch (e) { console.warn('Positions load failed:', e.message); }
  }
  function openAddPositionModal() {
    modal('Add Open Position', `
      ${field('op-title','Position','text','',true)}
      ${field('op-dept','Department','text','')}
      ${field('op-level','Level','text','')}
      ${field('op-apps','Applications','number','0')}
    `, async (root, close, err) => {
      const title = root.querySelector('#op-title').value.trim();
      if (!title) { err('Position title is required.'); return; }
      const created = await CardioAPI.create('positions', {
        title, department: root.querySelector('#op-dept').value.trim(),
        level: root.querySelector('#op-level').value.trim(),
        applications: Number(root.querySelector('#op-apps').value) || 0,
        status: 'open', postedDate: new Date().toISOString().slice(0, 10),
      });
      positionsCache.push(created); renderPositions(); close();
    });
  }

  // ---- 11. Early Adopters ------------------------------------------------
  let adoptersCache = [];
  function renderAdopters() {
    const tbody = document.getElementById('adopters-tbody');
    if (!tbody) return;
    if (!adoptersCache.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:1.5rem;">No participants yet.</td></tr>`;
    } else {
      tbody.innerHTML = adoptersCache.map((a) => `
        <tr data-id="${esc(a.id)}">
          <td><strong>${esc(a.name)}</strong></td>
          <td>${esc(a.champion || '—')}</td>
          <td>${esc(a.engagement || '—')}</td>
          <td>${esc(a.betaInterest || '—')}</td>
          <td>${fmtDate(a.joinedDate)}</td>
          <td><span class="status-badge active"><span class="status-indicator"></span> ${esc(a.status || 'Active')}</span></td>
          <td>${removeBtn('ea-remove', a.id, 'Remove')}</td>
        </tr>`).join('');
      wireRemove(tbody, 'ea-remove', 'adopters', adoptersCache, (next) => { adoptersCache = next; renderAdopters(); });
    }
  }
  async function initAdopters() {
    if (!document.getElementById('adopters-tbody')) return;
    try {
      adoptersCache = await CardioAPI.list('adopters');
      renderAdopters();
      ensureActionButton('early-adopter-section', /add\s*participant|add\s*adopter|enroll/i, '➕ Add Participant', openAddAdopterModal);
    } catch (e) { console.warn('Adopters load failed:', e.message); }
  }
  function openAddAdopterModal() {
    modal('Add Program Participant', `
      ${field('ea-name','Organization','text','',true)}
      ${field('ea-champion','Champion','text','')}
      ${field('ea-tier','Tier','text','Early Adopter')}
      ${selectField('ea-eng','Engagement',[['High','High'],['Medium','Medium'],['Low','Low']])}
      ${selectField('ea-interest','Beta interest',[['Confirmed','Confirmed'],['Interested','Interested'],['Undecided','Undecided']])}
      ${field('ea-ref','Referrals','number','0')}
    `, async (root, close, err) => {
      const name = root.querySelector('#ea-name').value.trim();
      if (!name) { err('Organization is required.'); return; }
      const created = await CardioAPI.create('adopters', {
        name, champion: root.querySelector('#ea-champion').value.trim(),
        tier: root.querySelector('#ea-tier').value.trim(),
        engagement: root.querySelector('#ea-eng').value,
        betaInterest: root.querySelector('#ea-interest').value,
        referrals: Number(root.querySelector('#ea-ref').value) || 0,
        status: 'active', joinedDate: new Date().toISOString().slice(0, 10),
      });
      adoptersCache.push(created); renderAdopters(); close();
    });
  }

  // Set a KPI card's value by matching its card-title within a section.
  function setCardValue(sectionId, titleRe, value) {
    const section = document.getElementById(sectionId);
    if (!section) return;
    const titleEl = Array.from(section.querySelectorAll('.card-title'))
      .find((t) => titleRe.test(t.textContent || ''));
    if (!titleEl) return;
    const card = titleEl.closest('.card') || titleEl.parentElement.parentElement;
    const valEl = card && card.querySelector('.metric-value, .stat-value');
    if (valEl) valEl.textContent = value;
  }

  function num(v) {
    const str = String(v == null ? '' : v);
    const m = str.replace(/[,$ ]/g, '').match(/-?\d+\.?\d*/);
    let n = m ? parseFloat(m[0]) : 0;
    if (/m\b/i.test(str)) n *= 1e6; else if (/k\b/i.test(str)) n *= 1e3;
    return n;
  }

  // Compute KPI cards from live data; hide any card with no backing value.
  async function computeKPIs() {
    const cache = {};
    const get = async (r) => { if (!cache[r]) cache[r] = await CardioAPI.list(r).catch(() => []); return cache[r]; };
    const sum = (arr, f) => arr.reduce((s, x) => s + num(x[f]), 0);

    const team = await get('team');
    const cust = await get('customers');
    const tickets = await get('tickets');
    const fda = await get('fdasubmissions');
    const studies = await get('clinicalstudies');
    const cloud = await get('cloudinfra');
    const itTickets = await get('ittickets');
    const training = await get('trainingprograms');
    const certs = await get('certifications');
    const inits = await get('strategicinitiatives');
    const btSites = await get('betatestingsites');
    const parts = await get('participants');
    const deals = await get('deals');
    const positions = await get('positions');

    const C = [
      ['dashboard-section', /team size/i, team.length],
      ['team-section', /team size|total headcount|employees/i, team.length],
      ['team-section', /open (positions|roles)/i, positions.length],
      ['customers-section', /total customers/i, cust.length],
      ['customers-section', /avg health/i, cust.length ? Math.round(sum(cust, 'healthScore') / cust.length) : '—'],
      ['support-section', /open tickets/i, tickets.filter((t) => t.status !== 'closed').length],
      ['regulatory-section', /(total|active) (submissions|filings)/i, fda.length],
      ['regulatory-section', /(in review|pending|under review)/i, fda.filter((f) => /review|pending|prepar/i.test(f.status || '')).length],
      ['clinical-ops-section', /(active|total) (studies|trials)/i, studies.length],
      ['clinical-ops-section', /(total )?enrolled|enrollment/i, sum(studies, 'enrolled')],
      ['it-systems-section', /(cloud )?services|infrastructure/i, cloud.length],
      ['it-systems-section', /open (it )?tickets|it support/i, itTickets.length],
      ['training-section', /(total )?programs/i, training.length],
      ['training-section', /(total )?enrolled|enrollment/i, sum(training, 'enrolled')],
      ['security-section', /certifications/i, certs.length],
      ['operations-section', /(active|total) initiatives/i, inits.length],
      ['beta-testing-section', /(total |active )?sites/i, btSites.length],
      ['early-adopter-section', /(active )?participants/i, parts.length],
      ['business-development-section', /(total|active) (deals|opportunities)/i, deals.length],
      ['business-development-section', /pipeline value/i, '$' + sum(deals, 'value').toLocaleString()],
    ];
    C.forEach(([sec, re, val]) => { if (val !== '—') setCardValue(sec, re, val); });
  }

  // Fill the remaining standalone KPI cards from the editable kpis store, and
  // make each click-to-edit (persists to /api/kpis).
  let kpisStore = {};
  async function applyStoredKPIs() {
    try { kpisStore = await CardioAPI.kpis(); } catch (e) { return; }
    Object.entries(kpisStore).forEach(([key, val]) => {
      const sep = key.indexOf('::');
      if (sep === -1) return;
      const sectionId = key.slice(0, sep) + '-section';
      const label = key.slice(sep + 2);
      setEditableKPI(sectionId, label, val, key);
    });
  }

  function setEditableKPI(sectionId, label, value, key) {
    const section = document.getElementById(sectionId);
    if (!section) return;
    const labelEl = Array.from(section.querySelectorAll('.card-title, .stat-label, .mini-stat-label'))
      .find((t) => (t.textContent || '').trim().toLowerCase() === label.toLowerCase());
    if (!labelEl) return;
    const card = labelEl.closest('.card') || labelEl.parentElement.parentElement;
    const valEl = card && card.querySelector('.metric-value, .stat-value, .mini-stat-value');
    if (!valEl) return;
    // Only fill if it's still the placeholder (don't clobber computed live values).
    if (valEl.textContent.trim() !== '—') return;
    valEl.textContent = value;
    valEl.dataset.kpiKey = key;
    valEl.style.cursor = 'pointer';
    valEl.title = 'Click to edit';
    valEl.addEventListener('click', () => editKPI(valEl, key));
  }

  function editKPI(valEl, key) {
    const cur = valEl.textContent;
    const input = document.createElement('input');
    input.value = cur;
    input.style.cssText = 'width:6em;font:inherit;background:#0A1929;color:#E8F1F5;border:1px solid #2B7BC4;border-radius:6px;padding:0.15rem 0.4rem;';
    valEl.style.display = 'none';
    valEl.parentNode.insertBefore(input, valEl);
    input.focus(); input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      const nv = save ? (input.value.trim() || cur) : cur;
      valEl.textContent = nv;
      valEl.style.display = '';
      input.remove();
      if (save && nv !== cur) {
        kpisStore[key] = nv;
        try { await CardioAPI.saveKpis(kpisStore); } catch (e) { alert('Could not save: ' + e.message); }
      }
    };
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { finish(false); }
    });
  }

  // Hide any KPI card still showing the placeholder (no computed or stored value).
  function finalSweepKPIs() {
    document.querySelectorAll('.metric-value, .stat-value, .mini-stat-value').forEach((el) => {
      if (el.textContent.trim() === '—') {
        const card = el.closest('.card');
        if (card) card.style.display = 'none';
      }
    });
  }

  const GENERIC_TABLES = [
    {tbody:"strategicpartners-tbody",route:"strategicpartners",section:"commercial-strategy",title:"Strategic Partnerships",cols:[{f:"partner",l:"Partner"},{f:"type",l:"Type"},{f:"strategicValue",l:"Strategic Value"},{f:"status",l:"Status"}]},
    {tbody:"fdasubmissions-tbody",route:"fdasubmissions",section:"regulatory",title:"FDA Submissions",cols:[{f:"submissionId",l:"Submission ID"},{f:"type",l:"Type"},{f:"productDevice",l:"Product/Device"},{f:"status",l:"Status"},{f:"targetSubmission",l:"Target Submission"},{f:"targetDecision",l:"Target Decision"},{f:"lead",l:"Lead"}]},
    {tbody:"intlregulatory-tbody",route:"intlregulatory",section:"regulatory",title:"International Regulatory",cols:[{f:"countryRegion",l:"Country/Region"},{f:"regulatoryBody",l:"Regulatory Body"},{f:"status",l:"Status"},{f:"certification",l:"Certification"},{f:"targetSubmission",l:"Target Submission"}]},
    {tbody:"clinicalstudies-tbody",route:"clinicalstudies",section:"clinical-ops",title:"Clinical Studies",cols:[{f:"studyId",l:"Study ID"},{f:"title",l:"Title"},{f:"phase",l:"Phase"},{f:"status",l:"Status"},{f:"sites",l:"Sites"},{f:"enrolled",l:"Enrolled"},{f:"target",l:"Target"},{f:"primaryCompletion",l:"Primary Completion"}]},
    {tbody:"safetyevents-tbody",route:"safetyevents",section:"clinical-ops",title:"Safety",cols:[{f:"saeId",l:"SAE ID"},{f:"study",l:"Study"},{f:"site",l:"Site"},{f:"eventDescription",l:"Event Description"},{f:"severity",l:"Severity"},{f:"relatedToDevice",l:"Related to Device"},{f:"reportedDate",l:"Reported Date"},{f:"status",l:"Status"}]},
    {tbody:"cloudinfra-tbody",route:"cloudinfra",section:"it-systems",title:"Cloud Infrastructure",cols:[{f:"service",l:"Service"},{f:"region",l:"Region"},{f:"instances",l:"Instances"},{f:"status",l:"Status"},{f:"monthlyCost",l:"Monthly Cost"}]},
    {tbody:"appstack-tbody",route:"appstack",section:"it-systems",title:"Application Stack",cols:[{f:"service",l:"Service"},{f:"version",l:"Version"},{f:"instances",l:"Instances"},{f:"status",l:"Status"},{f:"cpu",l:"CPU"},{f:"memory",l:"Memory"}]},
    {tbody:"itdatabases-tbody",route:"itdatabases",section:"it-systems",title:"Database Management",cols:[{f:"database",l:"Database"},{f:"type",l:"Type"},{f:"size",l:"Size"},{f:"status",l:"Status"},{f:"replication",l:"Replication"},{f:"lastBackup",l:"Last Backup"}]},
    {tbody:"monitoringalerts-tbody",route:"monitoringalerts",section:"it-systems",title:"Monitoring",cols:[{f:"alertType",l:"Alert Type"},{f:"threshold",l:"Threshold"},{f:"status",l:"Status"},{f:"lastTriggered",l:"Last Triggered"},{f:"recipients",l:"Recipients"}]},
    {tbody:"itassets-tbody",route:"itassets",section:"it-systems",title:"Compliance Status",cols:[{f:"assetId",l:"Asset ID"},{f:"deviceType",l:"Device Type"},{f:"model",l:"Model"},{f:"assignedTo",l:"Assigned To"},{f:"status",l:"Status"},{f:"lastCheckIn",l:"Last Check-in"},{f:"compliance",l:"Compliance"}]},
    {tbody:"securitypolicies-tbody",route:"securitypolicies",section:"it-systems",title:"Device Security",cols:[{f:"securityPolicy",l:"Security Policy"},{f:"requirement",l:"Requirement"},{f:"complianceRate",l:"Compliance Rate"},{f:"nonCompliant",l:"Non-Compliant"},{f:"status",l:"Status"}]},
    {tbody:"certifications-tbody",route:"certifications",section:"security",title:"Compliance Certifications",cols:[{f:"certification",l:"Certification"},{f:"status",l:"Status"},{f:"lastAudit",l:"Last Audit"},{f:"nextAudit",l:"Next Audit"},{f:"auditor",l:"Auditor"},{f:"score",l:"Score"}]},
    {tbody:"trainingprograms-tbody",route:"trainingprograms",section:"training",title:"Training Programs",cols:[{f:"program",l:"Program"},{f:"type",l:"Type"},{f:"duration",l:"Duration"},{f:"enrolled",l:"Enrolled"},{f:"completed",l:"Completed"},{f:"passRate",l:"Pass Rate"}]},
    {tbody:"strategicinitiatives-tbody",route:"strategicinitiatives",section:"operations",title:"Strategic Initiatives",cols:[{f:"initiative",l:"Initiative"},{f:"owner",l:"Owner"},{f:"status",l:"Status"},{f:"progress",l:"Progress"},{f:"targetDate",l:"Target Date"},{f:"impact",l:"Impact"}]},
    {tbody:"betatestingsites-tbody",route:"betatestingsites",section:"beta-testing",title:"Beta Sites Status",cols:[{f:"site",l:"Site"},{f:"patients",l:"Patients"},{f:"tests",l:"Tests"},{f:"uptime",l:"Uptime"},{f:"status",l:"Status"}]},
    {tbody:"businessdevelopmentx1-tbody",route:"implementations",section:"business-development",title:"Organization table",cols:[{f:"organization",l:"Organization"},{f:"contractValue",l:"Contract Value"},{f:"term",l:"Term"},{f:"signedDate",l:"Signed Date"},{f:"goLiveTarget",l:"Go-Live Target"},{f:"status",l:"Status"}]},
    {tbody:"businessdevelopmentx2-tbody",route:"leadsources",section:"business-development",title:"Source table",cols:[{f:"source",l:"Source"},{f:"leadsGenerated",l:"Leads Generated"},{f:"conversionRate",l:"Conversion Rate"},{f:"costPerLead",l:"Cost Per Lead"},{f:"pipelineValue",l:"Pipeline Value"},{f:"roi",l:"ROI"}]},
    {tbody:"earlyadopterx1-tbody",route:"participants",section:"early-adopter",title:"Organization table",cols:[{f:"organization",l:"Organization"},{f:"champion",l:"Champion"},{f:"enrollmentDate",l:"Enrollment Date"},{f:"engagement",l:"Engagement"},{f:"betaInterest",l:"Beta Interest"},{f:"referrals",l:"Referrals"},{f:"status",l:"Status"}]},
    {tbody:"earlyadopterx2-tbody",route:"programbenefits",section:"early-adopter",title:"Benefit table",cols:[{f:"benefit",l:"Benefit"},{f:"description",l:"Description"},{f:"value",l:"Value"},{f:"eligibility",l:"Eligibility"},{f:"status",l:"Status"}]},
    {tbody:"earlyadopterx3-tbody",route:"engagementactivities",section:"early-adopter",title:"Activity table",cols:[{f:"activity",l:"Activity"},{f:"type",l:"Type"},{f:"date",l:"Date"},{f:"participants",l:"Participants"},{f:"status",l:"Status"}]},
    {tbody:"earlyadopterx4-tbody",route:"programmetrics",section:"early-adopter",title:"Metric table",cols:[{f:"metric",l:"Metric"},{f:"current",l:"Current"},{f:"target",l:"Target"},{f:"status",l:"Status"},{f:"trend",l:"Trend"}]},
    {tbody:"supportx1-tbody",route:"supportteam",section:"support",title:"Team Member table",cols:[{f:"teamMember",l:"Team Member"},{f:"ticketsResolvedWeek",l:"Tickets Resolved (Week)"},{f:"avgResponseTime",l:"Avg Response Time"},{f:"csatScore",l:"CSAT Score"},{f:"activeTickets",l:"Active Tickets"},{f:"status",l:"Status"}]},
    {tbody:"itsystemsx1-tbody",route:"ittickets",section:"it-systems",title:"Ticket ID table",cols:[{f:"ticketId",l:"Ticket ID"},{f:"type",l:"Type"},{f:"issue",l:"Issue"},{f:"priority",l:"Priority"},{f:"status",l:"Status"},{f:"assignedTo",l:"Assigned To"},{f:"created",l:"Created"}]},
    {tbody:"itsystemsx2-tbody",route:"ittickets",section:"it-systems",title:"Ticket ID table",cols:[{f:"ticketId",l:"Ticket ID"},{f:"type",l:"Type"},{f:"issue",l:"Issue"},{f:"priority",l:"Priority"},{f:"status",l:"Status"},{f:"assignedTo",l:"Assigned To"},{f:"created",l:"Created"}]},
    {tbody:"itsystemsx3-tbody",route:"itescalations",section:"it-systems",title:"ID table",cols:[{f:"id",l:"ID"},{f:"customer",l:"Customer"},{f:"issue",l:"Issue"},{f:"priority",l:"Priority"},{f:"status",l:"Status"},{f:"created",l:"Created"}]}
  ];
  function genStatusBadge(v) {
    const t = String(v || '').toLowerCase();
    let cls = 'active';
    if (/(at[- ]?risk|warning|pending|in progress|preparing|degraded|review)/.test(t)) cls = 'warning';
    else if (/(closed|inactive|offline|blocked|non[- ]?compliant|critical|failed|rejected)/.test(t)) cls = 'pending';
    return `<span class="status-badge ${cls}"><span class="status-indicator"></span> ${esc(v)}</span>`;
  }

  function renderGenericTable(b, data) {
    const tbody = document.getElementById(b.tbody);
    if (!tbody) return;
    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="${b.cols.length + 1}" style="text-align:center;color:var(--text-muted);padding:1.5rem;">No records.</td></tr>`;
      return;
    }
    tbody.innerHTML = data.map((row) => {
      const cells = b.cols.map((c, i) => {
        let v = row[c.f];
        let inner = (v == null || v === '') ? '—' : (/status/i.test(c.f) ? genStatusBadge(v) : esc(v));
        return i === 0 ? `<td><strong>${inner}</strong></td>` : `<td>${inner}</td>`;
      }).join('');
      return `<tr data-id="${esc(row.id)}">${cells}<td>${removeBtn('g-remove', row.id, 'Remove')}</td></tr>`;
    }).join('');
    tbody.querySelectorAll('.g-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this record?')) return;
        try {
          await CardioAPI.remove(b.route, btn.getAttribute('data-id'));
          b._cache = b._cache.filter((x) => x.id !== btn.getAttribute('data-id'));
          renderGenericTable(b, b._cache);
        } catch (e) { alert('Could not remove: ' + e.message); }
      });
    });
  }

  function addAboveTable(b) {
    const tbody = document.getElementById(b.tbody);
    if (!tbody) return;
    const table = tbody.closest('table');
    if (!table || table.previousElementSibling?.classList?.contains('g-add')) return;
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary g-add';
    btn.style.marginBottom = '0.75rem';
    btn.textContent = '➕ Add';
    btn.addEventListener('click', () => {
      const fields = b.cols.map((c) => field('g-' + c.f, c.l, 'text', '')).join('');
      modal('Add to ' + b.title, fields, async (root, close, err) => {
        const payload = {};
        b.cols.forEach((c) => { payload[c.f] = root.querySelector('#g-' + c.f).value.trim(); });
        if (!Object.values(payload).some((v) => v)) { err('Enter at least one value.'); return; }
        const created = await CardioAPI.create(b.route, payload);
        b._cache.push(created);
        renderGenericTable(b, b._cache);
        close();
      });
    });
    table.parentNode.insertBefore(btn, table);
  }

  async function initGenericTables() {
    for (const b of GENERIC_TABLES) {
      const tbody = document.getElementById(b.tbody);
      if (!tbody) continue;
      try {
        b._cache = await CardioAPI.list(b.route);
        renderGenericTable(b, b._cache);
        addAboveTable(b);
      } catch (e) { console.warn(b.route, 'load failed:', e.message); }
    }
  }

  // ---- Generic modal helper ----------------------------------------------
  function modal(title, fieldsHTML, onSave) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-overlay';
    wrap.style.cssText = 'display:flex;position:fixed;inset:0;background:rgba(5,15,28,0.7);z-index:100000;align-items:center;justify-content:center;';
    wrap.innerHTML = `
      <div class="modal" style="background:linear-gradient(135deg,#1A2F47,#264159);border:1px solid #2A4A65;border-radius:16px;max-width:520px;width:92%;padding:1.75rem;color:#E8F1F5;box-shadow:0 24px 70px rgba(0,0,0,0.55);max-height:90vh;overflow:auto;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem;">
          <h3 style="margin:0;font-size:1.25rem;">${esc(title)}</h3>
          <button class="m-close" style="background:none;border:none;color:#9DB4C7;font-size:1.4rem;cursor:pointer;">✕</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.9rem;">${fieldsHTML}</div>
        <div class="m-error" style="color:#ff8a80;font-size:0.85rem;margin-top:0.75rem;min-height:1.1em;"></div>
        <div style="display:flex;gap:0.75rem;margin-top:1.25rem;">
          <button class="m-save" style="flex:1;background:linear-gradient(135deg,#1E5A8E,#2B7BC4);color:#fff;border:none;border-radius:10px;padding:0.8rem;font-weight:600;cursor:pointer;">Save</button>
          <button class="m-cancel" style="background:#22384f;color:#cfe0ec;border:1px solid #2A4A65;border-radius:10px;padding:0.8rem 1.1rem;cursor:pointer;">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    const err = (msg) => { wrap.querySelector('.m-error').textContent = msg; };
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    wrap.querySelector('.m-close').addEventListener('click', close);
    wrap.querySelector('.m-cancel').addEventListener('click', close);
    wrap.querySelector('.m-save').addEventListener('click', async () => {
      try { await onSave(wrap, close, err); }
      catch (e) { err('Could not save: ' + e.message); }
    });
  }

  // ---- Boot ---------------------------------------------------------------
  async function boot() {
    initUser();
    await Promise.all([
      initDashboard(), initBetaSites(), initTeam(), initFinancials(),
      initPipeline(), initCustomers(), initSupport(), initPositions(),
      initAdopters(), initGenericTables(),
    ]);
    await computeKPIs();
    await applyStoredKPIs();
    finalSweepKPIs();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
