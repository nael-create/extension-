// =====================================================================================
// Orchestrateur de la file de scraping automatique (dashboard.html) — cf. session du
// 2026-09-09. Le service worker MV3 est tué par Chrome après ~30s d'inactivité, même en
// pleine attente d'une réponse : un scan complet dure plusieurs minutes (jusqu'à 100
// scrolls x 2-4s + envoi des lots au Sheet), donc on NE PEUT PAS faire attendre ce fichier
// sur un seul long message pendant tout ce temps sans risquer qu'il soit suspendu en
// route et que la file s'arrête silencieusement.
//
// Le pattern retenu (idiomatique en MV3) : découpler le signal "je commence" du signal
// "j'ai fini". On envoie START_SCRAPING sans attendre de réponse longue ; content_script.js
// envoie ensuite des messages INDÉPENDANTS et ponctuels (SCRAPE_PROGRESS pendant le scan,
// SCRAPE_DONE à la fin) — chacun réveille ce service worker de façon garantie, même s'il
// s'était endormi entre-temps. Pour le délai volontaire ENTRE deux groupes (60-180s), un
// setTimeout classique serait lui aussi tué par la suspension : on utilise chrome.alarms,
// conçu justement pour programmer un réveil fiable même après suspension du worker.
//
// Limite connue : si Chrome (pas seulement l'onglet) est fermé ou plante en plein milieu
// d'un run, l'état de la file survit dans chrome.storage.local mais le groupe en cours de
// scan à ce moment-là est perdu (ni terminé ni remis en tête de file) — pas de reprise
// automatique après un crash complet du navigateur pour l'instant.
// =====================================================================================

const GROUPS_KEY = 'wtbGroups';
const QUEUE_KEY = 'wtbQueueState';
const ADVANCE_ALARM_NAME = 'wtbAdvanceQueue';

// Délai aléatoire entre deux groupes, dans le même esprit que le délai aléatoire entre
// scrolls déjà en place côté content_script.js : éviter un enchaînement mécanique et
// parfaitement régulier d'un groupe à l'autre.
const MIN_INTER_GROUP_DELAY_S = 60;
const MAX_INTER_GROUP_DELAY_S = 180;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const defaultQueueState = () => ({
  status: 'idle', // idle | running | stopped | done
  queue: [],
  currentGroupId: null,
  currentTabId: null,
  results: {},
  totalInRun: 0,
  scanMode: 'both', // 'wtb' | 'wts' | 'both' — choisi au démarrage de la file (cf. session du 2026-09-10)
  scrollLimit: 100 // 40 | 70 | 100 — choisi au démarrage de la file (cf. session du 2026-09-11)
});

const getGroups = () => new Promise((resolve) => {
  chrome.storage.local.get([GROUPS_KEY], (r) => resolve(r[GROUPS_KEY] || []));
});

const getQueueState = () => new Promise((resolve) => {
  chrome.storage.local.get([QUEUE_KEY], (r) => resolve(r[QUEUE_KEY] || defaultQueueState()));
});

const setQueueState = (state) => new Promise((resolve) => {
  chrome.storage.local.set({ [QUEUE_KEY]: state }, resolve);
});

const randomInterGroupDelaySeconds = () =>
  MIN_INTER_GROUP_DELAY_S + Math.random() * (MAX_INTER_GROUP_DELAY_S - MIN_INTER_GROUP_DELAY_S);

const waitForTabComplete = (tabId) => new Promise((resolve) => {
  const listener = (updatedTabId, changeInfo) => {
    if (updatedTabId === tabId && changeInfo.status === 'complete') {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
  };
  chrome.tabs.onUpdated.addListener(listener);
});

// Une fenêtre neuve à chaque groupe (cf. advanceQueue ci-dessous pour pourquoi on n'essaie
// plus de réutiliser/re-naviguer l'onglet du groupe précédent). focused:false pour ne jamais
// voler le focus clavier de l'utilisateur — pas minimisée (une fenêtre MINIMISÉE est traitée
// comme cachée par Chrome, avec le même throttling des timers qu'on essaie justement
// d'éviter, cf. session du 2026-09-11) et pas positionnée hors écran non plus : Chrome
// rejette toute fenêtre dont moins de 50% ne serait pas dans l'espace visible ("Invalid
// value for bounds", erreur réelle constatée, même session) — laisser Chrome choisir la
// position par défaut. Effet de bord assumé : une fenêtre visible apparaît à l'écran
// pendant le scan.
const openGroupWindow = (url) => new Promise((resolve, reject) => {
  chrome.windows.create({ url, focused: false, type: 'normal', width: 1200, height: 900 }, (win) => {
    if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
    const fromWin = win && win.tabs && win.tabs[0];
    if (fromWin) { resolve(fromWin); return; }
    // Filet de sécurité : certaines versions de Chrome ne peuplent pas `win.tabs` sur le
    // retour de windows.create malgré la doc — sans ce repli, une simple absence de champ
    // ferait échouer TOUT le groupe (et potentiellement la file entière) alors que la
    // fenêtre et l'onglet existent bel et bien (cf. session du 2026-09-11).
    if (!win || !win.id) { reject(new Error("Fenêtre de scraping créée sans identifiant.")); return; }
    chrome.tabs.query({ windowId: win.id }, (tabs) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      const tab = tabs && tabs[0];
      if (!tab) { reject(new Error("Fenêtre de scraping créée sans onglet.")); return; }
      resolve(tab);
    });
  });
});

// Traite la fin d'un groupe (succès, échec, ou erreur de démarrage côté background) :
// enregistre le résultat, puis décide de la suite — s'arrêter (file vide, arrêt demandé)
// ou programmer le groupe suivant après le délai aléatoire inter-groupe.
const handleGroupFinished = async (groupId, { status, count, details }) => {
  let state = await getQueueState();
  if (groupId !== state.currentGroupId) return; // message obsolète (groupe déjà remplacé)

  const prev = state.results[groupId] || {};
  state.results[groupId] = {
    ...prev,
    status,
    postsFound: typeof count === 'number' ? count : (prev.postsFound || 0),
    finishedAt: Date.now(),
    // Diagnostic : tri forcé ou déjà bon, nombre de scrolls, raison de l'arrêt — pour
    // pouvoir répondre a posteriori à ces questions sans console de l'onglet (déjà fermé
    // une fois le scan terminé), cf. session du 2026-09-10.
    ...(details || {})
  };
  state.currentGroupId = null;

  if (state.status !== 'running') {
    // Arrêt demandé pendant que ce groupe tournait ("Arrêter" = on finit le groupe en
    // cours puis on s'arrête) : on garde le résultat mais on n'enchaîne pas.
    await setQueueState(state);
    return;
  }

  if (state.queue.length === 0) {
    state.status = 'done';
    await setQueueState(state);
    return;
  }

  await setQueueState(state);
  const delaySeconds = randomInterGroupDelaySeconds();
  chrome.alarms.create(ADVANCE_ALARM_NAME, { delayInMinutes: delaySeconds / 60 });
};

// Démarre le scan du prochain groupe de la file : ouvre toujours une fenêtre neuve (voir
// openGroupWindow) et ferme celle du groupe précédent juste après — le réemploi d'un même
// onglet via tabs.update() a été abandonné après un échec constaté en conditions réelles
// (la page restait affichée sur le groupe précédent, cf. session du 2026-09-11).
const advanceQueue = async () => {
  let state = await getQueueState();
  if (state.status !== 'running') return;

  if (state.queue.length === 0) {
    state.status = 'done';
    await setQueueState(state);
    return;
  }

  const nextGroupId = state.queue.shift();
  const groups = await getGroups();
  const group = groups.find(g => g.id === nextGroupId);

  if (!group) {
    // Groupe supprimé de la liste entre-temps : on passe au suivant sans compter de
    // tentative (ce n'est pas un scan qui a eu lieu).
    await setQueueState(state);
    return advanceQueue();
  }

  state.currentGroupId = nextGroupId;
  state.results[nextGroupId] = { status: 'starting', postsFound: 0, startedAt: Date.now() };
  await setQueueState(state);

  try {
    // Une NOUVELLE fenêtre à chaque groupe plutôt que de réutiliser la précédente via
    // tabs.update() : depuis le passage à une fenêtre séparée hors écran (cf. plus haut,
    // anti-throttling), re-naviguer l'onglet existant vers l'URL du groupe suivant ne
    // déclenchait plus la navigation de façon fiable — le groupe suivant restait affiché sur
    // la page Facebook du groupe précédent (bug réel constaté, session du 2026-09-11). Plus
    // simple et plus robuste : une fenêtre neuve par groupe, l'ancienne fermée juste après.
    const previousTabId = state.currentTabId;
    const tab = await openGroupWindow(group.url);
    const tabId = tab.id;
    state = await getQueueState();
    state.currentTabId = tabId;
    await setQueueState(state);

    if (previousTabId && previousTabId !== tabId) {
      chrome.tabs.remove(previousTabId, () => { void chrome.runtime.lastError; });
    }

    await waitForTabComplete(tabId);
    // "complete" ne veut dire que "réseau/DOM initial prêts" — Facebook est une SPA qui
    // monte son feed après coup ; une courte pause laisse les posts apparaître avant de
    // lancer START_SCRAPING (cette attente est courte et se déroule PENDANT l'exécution
    // active de cette fonction, donc sans risque de suspension du service worker).
    await sleep(3000);

    // On ne s'appuie PAS sur cette réponse pour avancer la file (c'est SCRAPE_DONE, un
    // message indépendant, qui pilote la suite — voir le commentaire en tête de fichier) :
    // ce callback peut très bien ne se déclencher que des minutes plus tard, quand
    // content_script.js appelle enfin sendResponse. Il sert uniquement à détecter un échec
    // IMMÉDIAT de livraison (content script pas encore injecté, onglet fermé entre-temps...),
    // auquel cas on ne veut pas laisser ce groupe bloqué en "running" pour toujours.
    chrome.tabs.sendMessage(tabId, { action: 'START_SCRAPING', groupId: nextGroupId, scanMode: state.scanMode, scrollLimit: state.scrollLimit, category: group.category || 'pokemon' }, () => {
      if (chrome.runtime.lastError) {
        const message = chrome.runtime.lastError.message;
        console.error(`Échec immédiat de démarrage pour "${group.name}" : ${message}`);
        // stopReason diagnostique : sans ça, cet échec (content script pas encore injecté,
        // onglet fermé entre-temps...) ressort en "Error · 0 posts" sans aucune indication,
        // indiscernable d'une vraie exception dans content_script.js (cf. session du
        // 2026-09-10, question posée après un run "Error · 0 posts" sans détail).
        handleGroupFinished(nextGroupId, { status: 'error', count: 0, details: { stopReason: 'tab_message_failed', errorMessage: message } });
      }
    });

    state = await getQueueState();
    if (state.currentGroupId === nextGroupId) {
      const prev = state.results[nextGroupId] || {};
      state.results[nextGroupId] = { ...prev, status: 'running' };
      await setQueueState(state);
    }
  } catch (err) {
    console.error(`Erreur au démarrage du scraping pour "${group.name}" : ${err.message}`);
    await handleGroupFinished(nextGroupId, { status: 'error', count: 0, details: { stopReason: 'advance_queue_exception', errorMessage: err.message } });
  }
};

// Si l'onglet réutilisé pour le scraping est fermé manuellement pendant un run, on
// s'arrête proprement plutôt que d'ouvrir un nouvel onglet sans que l'utilisateur s'y
// attende.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getQueueState();
  if (state.currentTabId !== tabId || state.status !== 'running') return;

  state.status = 'stopped';
  if (state.currentGroupId) {
    const prev = state.results[state.currentGroupId] || {};
    state.results[state.currentGroupId] = {
      ...prev,
      status: 'error',
      error: 'Onglet fermé manuellement',
      finishedAt: Date.now()
    };
  }
  state.currentTabId = null;
  await setQueueState(state);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ADVANCE_ALARM_NAME) advanceQueue();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'SEND_TO_SHEET') {
    // 1. Récupérer l'URL du webhook depuis le stockage local (sauvée par la popup)
    chrome.storage.local.get(['webhookUrl'], async (result) => {
      const url = result.webhookUrl;

      if (!url) {
        console.error("Webhook URL manquante.");
        sendResponse({ success: false, error: 'Pas de Webhook URL' });
        return;
      }

      // 2. Envoyer les données
      try {
        // Le Apps Script s'attend à recevoir la même structure que le script Python: { "rows": [...] }
        // Note: L'envoi vers Apps Script se fait souvent mieux en mode 'no-cors' ou
        // texte brut selon la configuration du doGet/doPost, mais un POST JSON simple marche
        // avec le content-type par défaut (text/plain) qui évite le preflight CORS.
        const response = await fetch(url, {
          method: 'POST',
          body: JSON.stringify({ rows: request.payload })
        });

        // Google Apps Script retourne souvent un 200 même si redirect
        sendResponse({ success: true });

      } catch (error) {
        console.error('Erreur d\'envoi vers le Sheet:', error);
        sendResponse({ success: false, error: error.message });
      }
    });

    // 3. Garder le canal de communication ouvert pour la réponse asynchrone
    return true;
  }

  if (request.action === 'START_QUEUE') {
    (async () => {
      const groupIds = Array.isArray(request.groupIds) ? request.groupIds : [];
      let state = await getQueueState();
      state.status = 'running';
      state.queue = groupIds.slice();
      state.currentGroupId = null;
      state.results = {};
      state.totalInRun = groupIds.length; // pour la barre de progression globale du dashboard
      state.scanMode = ['wtb', 'wts', 'both'].includes(request.scanMode) ? request.scanMode : 'both';
      state.scrollLimit = [40, 70, 100].includes(request.scrollLimit) ? request.scrollLimit : 100;
      // currentTabId n'est pas réinitialisé : si un onglet de scraping existe déjà d'un
      // run précédent, on le réutilise au lieu d'en ouvrir un nouveau.
      await setQueueState(state);
      advanceQueue();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (request.action === 'STOP_QUEUE') {
    (async () => {
      const state = await getQueueState();
      // "Arrêter" = termine le groupe en cours puis s'arrête, ne coupe jamais un scroll
      // ou un envoi de lot en plein milieu (pas de lot à moitié envoyé).
      state.status = 'stopped';
      chrome.alarms.clear(ADVANCE_ALARM_NAME);
      await setQueueState(state);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (request.action === 'SCRAPE_PROGRESS') {
    (async () => {
      const state = await getQueueState();
      if (request.groupId !== state.currentGroupId) return; // ping obsolète, on ignore
      const prev = state.results[request.groupId] || {};
      state.results[request.groupId] = {
        ...prev,
        status: 'running',
        postsFound: request.postsFound ?? prev.postsFound ?? 0,
        scrollIndex: request.scrollIndex ?? prev.scrollIndex,
        scrollLimit: request.scrollLimit ?? prev.scrollLimit,
        statusText: request.statusText ?? prev.statusText
      };
      await setQueueState(state);
    })();
    return false; // fire-and-forget, aucune réponse attendue
  }

  if (request.action === 'SCRAPE_DONE') {
    (async () => {
      await handleGroupFinished(request.groupId, { status: request.status, count: request.count, details: request.details });
    })();
    return false;
  }
});
