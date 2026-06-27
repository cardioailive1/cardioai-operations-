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

  function renderBetaSites() {
    const tbody = document.getElementById('beta-sites-tbody');
    if (!tbody) return;
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
      grid.innerHTML = `<div style="color:var(--text-muted);padding:1.5rem;">No team members yet. Use “Add Team Member”.</div>`;
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
    return `
      <tr data-id="${esc(d.id)}">
        <td><strong>${esc(d.account)}</strong></td>
        <td>${esc(d.contact || '—')}</td>
        <td><span class="status-badge active"><span class="status-indicator"></span> ${esc(stage)}</span></td>
        <td>${money(d.value)}</td>
        <td>${esc(prob)}</td>
        <td>${esc(d.nextAction || '—')}</td>
        <td>${esc(d.owner || '—')}</td>
        <td style="white-space:nowrap;">
          <button class="dl-remove" data-id="${esc(d.id)}" title="Remove"
            style="background:rgba(232,57,70,0.15);color:#ff8a80;border:1px solid rgba(232,57,70,0.4);border-radius:6px;padding:0.3rem 0.6rem;cursor:pointer;font-size:0.8rem;">✕</button>
        </td>
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
  function boot() {
    initUser();
    initDashboard();
    initBetaSites();
    initTeam();
    initFinancials();
    initPipeline();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
