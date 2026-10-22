// Dashboard = page interne à l'extension (chrome-extension://<id>/dashboard.html), pas un
// fichier local séparé — une page file:// n'a aucun accès aux API chrome.* de l'extension,
// alors qu'une page de l'extension y accède directement (cf. session du 2026-09-09).
// Cette page ne fait AUCUNE logique de scraping elle-même : elle lit/écrit
// chrome.storage.local (groupes + état de la file) et laisse toute l'orchestration à
// background.js, seule source de vérité pendant un run.

const GROUPS_KEY = 'wtbGroups';
const QUEUE_KEY = 'wtbQueueState';
// Doit rester identique à DEDUP_STORAGE_KEY dans content_script.js — ne pas faire diverger
// les deux copies (cf. session du 2026-09-11, bouton "Clear scan history").
const DEDUP_KEY = 'wtbSeenDedupKeys';

let groups = [];
let queueState = {
  status: 'idle', queue: [], currentGroupId: null, results: {},
  totalInRun: 0
};
let searchTerm = '';
let editingId = null; // groupe actuellement en édition inline dans la liste
let openMenuId = null; // menu ⋮ actuellement ouvert

const el = (id) => document.getElementById(id);

const escapeHtml = (s) => (s || '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const loadAll = () => new Promise((resolve) => {
  chrome.storage.local.get([GROUPS_KEY, QUEUE_KEY], (stored) => {
    groups = stored[GROUPS_KEY] || [];
    queueState = stored[QUEUE_KEY] || queueState;
    resolve();
  });
});

const saveGroups = () => new Promise((resolve) => {
  chrome.storage.local.set({ [GROUPS_KEY]: groups }, resolve);
});

const statusLabel = (s) => ({
  idle: 'Idle',
  running: 'Running',
  stopped: 'Stopped',
  done: 'Done'
}[s] || s);

// Libellés des résultats par groupe dans l'historique (success/error/partial viennent de
// background.js/content_script.js, valeurs internes non traduites).
const resultStatusLabel = (s) => ({
  success: 'Success',
  error: 'Error',
  partial: 'Partial'
}[s] || s);

// Libellé compact des champs diagnostiques (sortForced/scrollsPerformed/stopReason,
// remplis par content_script.js via SCRAPE_DONE) — utile pour répondre après coup à "le tri
// a-t-il été forcé ?", "combien de scrolls ?", "pourquoi l'arrêt ?" sans console de l'onglet,
// qui n'existe plus une fois le scan terminé (cf. session du 2026-09-10).
const STOP_REASON_LABEL = {
  // scroll_limit non listé volontairement : déjà évident via le nombre de scrolls affiché
  // (ex: "100 scrolls" == limite atteinte).
  early_stop: 'stopped early (no new posts)',
  selector_broken: 'DOM selector broken',
  sort_selector_broken: 'sort selector broken',
  sort_menu_not_opened: 'sort menu did not open',
  sort_option_not_found: 'sort option not found',
  sort_button_not_found: 'sort button not found',
  // Ces deux-là viennent de background.js (échec avant même que content_script.js ne
  // démarre : onglet fermé, message non livré...), pas de content_script.js — cf. session
  // du 2026-09-10, ajoutés après un "Error · 0 posts" sans aucun détail.
  tab_message_failed: 'could not reach tab',
  advance_queue_exception: 'queue error before scan started'
};
const diagnosticLabel = (r) => {
  const parts = [];
  if (typeof r.sortForced === 'boolean') parts.push(r.sortForced ? 'sort forced' : 'sort already newest');
  if (typeof r.scrollsPerformed === 'number') parts.push(`${r.scrollsPerformed} scrolls`);
  if (r.stopReason && STOP_REASON_LABEL[r.stopReason]) parts.push(STOP_REASON_LABEL[r.stopReason]);
  // Distingue "aucun WTB/WTS dans ces scrolls" de "déjà envoyés lors d'un run précédent" —
  // sans ça, "0 posts" après un arrêt anticipé est ambigu (cf. question posée après un run
  // à 0 posts, session du 2026-09-10).
  if (typeof r.alreadySeenTotal === 'number' && r.alreadySeenTotal > 0) {
    parts.push(`${r.alreadySeenTotal} already sent before`);
  }
  if (r.errorMessage) parts.push(r.errorMessage);
  return parts.join(' · ');
};

const getSelectedIds = () =>
  Array.from(document.querySelectorAll('#groupList input[type=checkbox]:checked')).map(cb => cb.dataset.id);

// Petit "flash" d'opacité quand une valeur change, pour rendre les mises à jour en
// direct plus lisibles qu'un simple remplacement de texte instantané.
const setTextAnimated = (id, text) => {
  const node = el(id);
  if (!node) return;
  const newText = String(text);
  if (node.textContent === newText) return;
  node.classList.add('flash');
  node.textContent = newText;
  requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove('flash')));
};

const renderGroupRow = (g) => {
  const isBusy = queueState.currentGroupId === g.id && queueState.status === 'running';

  const category = g.category === 'guitars' ? 'guitars' : 'pokemon';

  if (editingId === g.id) {
    return `
      <div class="group-card">
        <div class="group-edit">
          <input type="text" class="input-glass" data-edit-name="${g.id}" value="${escapeHtml(g.name)}">
          <input type="text" class="input-glass" data-edit-url="${g.id}" value="${escapeHtml(g.url)}">
          <select class="input-glass" data-edit-category="${g.id}" style="flex:0 0 auto;">
            <option value="pokemon" ${category === 'pokemon' ? 'selected' : ''}>Pokémon</option>
            <option value="guitars" ${category === 'guitars' ? 'selected' : ''}>Guitares</option>
          </select>
          <div class="edit-actions">
            <button class="btn btn-primary" data-save="${g.id}" style="padding:6px 12px;">Save</button>
            <button class="btn btn-ghost-sm" data-cancel-edit="${g.id}">Cancel</button>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="group-card ${isBusy ? 'is-busy' : ''}">
      <input type="checkbox" data-id="${g.id}" ${isBusy ? 'disabled' : ''}>
      <div class="group-info">
        <div class="group-name">${escapeHtml(g.name)}</div>
        <div class="group-url">${escapeHtml(g.url)}</div>
      </div>
      <span class="group-category-badge" data-category="${category}">${category === 'guitars' ? 'Guitares' : 'Pokémon'}</span>
      <div class="kebab-wrap">
        <button class="kebab-btn" data-menu="${g.id}">⋮</button>
      </div>
    </div>
  `;
};

// Le menu ⋮ est un seul élément partagé (#sharedDropdown dans dashboard.html), positionné
// en `fixed` et déplacé sous le bouton cliqué — s'il vivait dans #groupList (qui défile),
// son overflow-y:auto couperait aussi le débordement horizontal du menu (cf. session du
// 2026-09-09).
const openDropdownFor = (button, groupId) => {
  const dropdown = el('sharedDropdown');
  const rect = button.getBoundingClientRect();
  dropdown.style.top = `${rect.bottom + 4}px`;
  dropdown.style.left = `${Math.max(8, rect.right - 140)}px`;
  dropdown.dataset.groupId = groupId;
  dropdown.hidden = false;
  openMenuId = groupId;
};

const closeDropdown = () => {
  el('sharedDropdown').hidden = true;
  openMenuId = null;
};

const renderGroupList = () => {
  const list = el('groupList');
  const term = searchTerm.trim().toLowerCase();
  const filtered = groups.filter(g =>
    !term || g.name.toLowerCase().includes(term) || g.url.toLowerCase().includes(term)
  );

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty">${groups.length === 0 ? 'No groups added yet.' : 'No results for this search.'}</div>`;
    return;
  }

  list.innerHTML = filtered.map(renderGroupRow).join('');
};

const renderQueuePanel = () => {
  const statusPill = el('statusPill');
  statusPill.dataset.status = queueState.status;
  setTextAnimated('queueStatus', statusLabel(queueState.status));

  // Progression globale de la file (groupes terminés / total sélectionné au démarrage).
  const finishedEntries = Object.values(queueState.results || {})
    .filter(r => r.status && r.status !== 'starting' && r.status !== 'running');
  const total = queueState.totalInRun || (finishedEntries.length + (queueState.queue || []).length + (queueState.currentGroupId ? 1 : 0));
  const overallPct = total > 0 ? Math.min(100, (finishedEntries.length / total) * 100) : 0;
  el('overallProgressFill').style.width = `${overallPct}%`;

  const currentGroup = groups.find(g => g.id === queueState.currentGroupId);
  const currentResult = queueState.currentGroupId ? queueState.results[queueState.currentGroupId] : null;

  setTextAnimated('currentGroup', currentGroup ? currentGroup.name : '—');
  setTextAnimated('currentPostsFound', currentResult ? (currentResult.postsFound ?? 0) : '—');
  setTextAnimated('currentStatusText', currentResult
    ? (currentResult.statusText || (currentResult.status === 'starting' ? 'Opening group…' : '—'))
    : '—');

  let scrollPct = 0;
  if (currentResult && currentResult.scrollLimit) {
    scrollPct = Math.min(100, (currentResult.scrollIndex / currentResult.scrollLimit) * 100);
  } else if (currentResult && currentResult.status === 'running' && (currentResult.statusText || '').startsWith('Sending batch')) {
    scrollPct = 100; // scroll terminé, on est dans la phase d'envoi au Sheet
  }
  el('currentProgressFill').style.width = `${scrollPct}%`;
  el('currentProgressTrack').classList.toggle('static', queueState.status !== 'running');

  const remainingNames = (queueState.queue || []).map(id => groups.find(g => g.id === id)?.name || id);
  setTextAnimated('remainingList', remainingNames.length ? remainingNames.join(', ') : '—');

  const historyEntries = Object.entries(queueState.results || {})
    .filter(([, r]) => r.status && r.status !== 'starting' && r.status !== 'running')
    .sort((a, b) => (b[1].finishedAt || 0) - (a[1].finishedAt || 0));

  const historyDiv = el('historyList');
  if (historyEntries.length === 0) {
    historyDiv.innerHTML = '<div class="empty">Nothing yet.</div>';
  } else {
    historyDiv.innerHTML = historyEntries.map(([id, r]) => {
      const name = groups.find(g => g.id === id)?.name || id;
      const diag = diagnosticLabel(r);
      return `
        <div class="history-row" data-status="${escapeHtml(r.status)}">
          <div class="history-row-main">
            <span class="history-name">${escapeHtml(name)}</span>
            <span class="history-meta">${escapeHtml(resultStatusLabel(r.status))} · ${r.postsFound ?? 0} posts</span>
          </div>
          ${diag ? `<span class="history-diag">${escapeHtml(diag)}</span>` : ''}
        </div>
      `;
    }).join('');
  }

  el('startBtn').disabled = queueState.status === 'running';
  el('stopBtn').disabled = queueState.status !== 'running';

  // Le choix WTB/WTS/Both n'est capturé qu'au clic sur Start (cf. handler ci-dessous) — le
  // désactiver pendant un run évite de laisser croire qu'il s'applique en cours de route.
  const isRunning = queueState.status === 'running';
  el('clearDedupBtn').disabled = isRunning;
  document.querySelectorAll('input[name="scanMode"]').forEach((input) => {
    input.disabled = isRunning;
    if (isRunning) input.checked = input.value === (queueState.scanMode || 'both');
  });
  document.querySelectorAll('input[name="scrollLimit"]').forEach((input) => {
    input.disabled = isRunning;
    if (isRunning) input.checked = Number(input.value) === (queueState.scrollLimit || 100);
  });
};

const render = () => {
  renderGroupList();
  renderQueuePanel();
};

const closeMenuOnOutsideClick = (e) => {
  if (openMenuId && !e.target.closest('.kebab-wrap') && !e.target.closest('#sharedDropdown')) {
    closeDropdown();
  }
};

const init = async () => {
  await loadAll();
  render();

  el('addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = el('groupNameInput').value.trim();
    const url = el('groupUrlInput').value.trim();
    if (!name || !url) return;
    const category = el('groupCategoryInput').value === 'guitars' ? 'guitars' : 'pokemon';
    groups.push({ id: genId(), name, url, category, addedAt: Date.now() });
    await saveGroups();
    el('groupNameInput').value = '';
    el('groupUrlInput').value = '';
    renderGroupList();
  });

  el('searchInput').addEventListener('input', (e) => {
    searchTerm = e.target.value;
    renderGroupList();
  });

  el('groupList').addEventListener('click', async (e) => {
    const menuId = e.target.dataset.menu;
    if (menuId) {
      if (openMenuId === menuId) closeDropdown();
      else openDropdownFor(e.target, menuId);
      return;
    }

    const cancelEditId = e.target.dataset.cancelEdit;
    if (cancelEditId) {
      editingId = null;
      renderGroupList();
      return;
    }

    const saveId = e.target.dataset.save;
    if (saveId) {
      const nameInput = document.querySelector(`[data-edit-name="${saveId}"]`);
      const urlInput = document.querySelector(`[data-edit-url="${saveId}"]`);
      const categoryInput = document.querySelector(`[data-edit-category="${saveId}"]`);
      const newName = nameInput.value.trim();
      const newUrl = urlInput.value.trim();
      if (!newName || !newUrl) return;
      const group = groups.find(g => g.id === saveId);
      if (group) {
        group.name = newName;
        group.url = newUrl;
        group.category = categoryInput.value === 'guitars' ? 'guitars' : 'pokemon';
        await saveGroups();
      }
      editingId = null;
      renderGroupList();
    }
  });

  el('sharedDropdown').addEventListener('click', async (e) => {
    const action = e.target.dataset.action;
    const groupId = el('sharedDropdown').dataset.groupId;
    if (!action || !groupId) return;

    if (action === 'edit') {
      editingId = groupId;
      closeDropdown();
      renderGroupList();
      return;
    }

    if (action === 'delete') {
      const group = groups.find(g => g.id === groupId);
      closeDropdown();
      if (group && !confirm(`Delete "${group.name}" from the list?`)) return;
      groups = groups.filter(g => g.id !== groupId);
      await saveGroups();
      renderGroupList();
    }
  });

  document.addEventListener('click', closeMenuOnOutsideClick);

  el('startBtn').addEventListener('click', () => {
    const ids = getSelectedIds();
    if (ids.length === 0) {
      alert('Select at least one group before starting.');
      return;
    }
    // Choix WTB/WTS/Both appliqué à tout ce run (cf. session du 2026-09-10) — pas de
    // réglage par groupe, un seul sélecteur global au moment du démarrage suffit à l'usage
    // décrit ("scanner uniquement WTB sur une liste de groupes").
    const scanModeInput = document.querySelector('input[name="scanMode"]:checked');
    const scanMode = scanModeInput ? scanModeInput.value : 'both';
    // Limite de scrolls par groupe, choisie au démarrage (cf. session du 2026-09-11) — 100
    // reste la valeur la plus complète, 40/70 pour un scan plus rapide sur des groupes moins
    // actifs ou quand la couverture totale n'est pas nécessaire pour ce run.
    const scrollLimitInput = document.querySelector('input[name="scrollLimit"]:checked');
    const scrollLimit = scrollLimitInput ? parseInt(scrollLimitInput.value, 10) : 100;
    chrome.runtime.sendMessage({ action: 'START_QUEUE', groupIds: ids, scanMode, scrollLimit });
  });

  el('stopBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'STOP_QUEUE' });
  });

  // Vide la mémoire "déjà envoyé" (dédup persistante) pour repartir sur une base propre —
  // cf. session du 2026-09-11. Ne touche jamais au Google Sheet : uniquement
  // chrome.storage.local côté extension. Bloqué pendant un run pour éviter qu'un scan en
  // cours ne persiste une dédup partiellement vidée sous les pieds d'un autre groupe.
  el('clearDedupBtn').addEventListener('click', () => {
    if (queueState.status === 'running') {
      alert('Stop the queue before clearing scan history.');
      return;
    }
    if (!confirm('Clear the "already sent" memory? Every WTB/WTS post still visible on Facebook will count as new on the next scan (the Google Sheet itself is not touched).')) {
      return;
    }
    chrome.storage.local.remove([DEDUP_KEY], () => {
      alert('Scan history cleared.');
    });
  });

  // Mise à jour en direct : pas de polling, on réagit aux écritures de background.js
  // dans chrome.storage.local (groupes ou état de la file).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let needRender = false;
    if (changes[GROUPS_KEY]) { groups = changes[GROUPS_KEY].newValue || []; needRender = true; }
    if (changes[QUEUE_KEY]) { queueState = changes[QUEUE_KEY].newValue || queueState; needRender = true; }
    // Un menu ⋮ ouvert pointe vers un bouton dont la position peut changer si la liste se
    // re-rend pendant qu'il est ouvert (mise à jour live) — on le referme par sécurité.
    if (needRender && openMenuId) closeDropdown();
    if (needRender) render();
  });
};

document.addEventListener('DOMContentLoaded', init);
