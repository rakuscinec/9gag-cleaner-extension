'use strict';

/* ---------- stav ---------- */
let bridgeTabId = null;
let identity = null;      // { name, accountId, commentAuth }
let commentOptions = null; // { appId, host, cdnHost }
let items = [];           // zoznam komentárov
let sortKey = 'created';
let sortDesc = true;
let processing = false;
let stopLoading = false;

// Záloha, keby sa nepodarilo prečítať window._config z 9gag.com
const DEFAULT_COMMENT_OPTIONS = {
  appId: 'a_dd8f2b7d304a10edaf6f29517ea0ca4100a43d1b',
  host: 'comment.9gag.com',
  cdnHost: 'comment-cdn.9gag.com'
};

/* ---------- pomocné ---------- */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pad2(n) { return String(n).padStart(2, '0'); }

// Český formát: d.m.rrrr HH:MM:SS
function formatDateTime(ts) {
  const d = new Date(ts);
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function log(msg) {
  const el = document.getElementById('logOutput');
  el.textContent += `[${formatDateTime(Date.now())}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

function setStatus(msg) {
  document.getElementById('statusText').textContent = msg;
}

/* ---------- bridge tab (9gag.com) ---------- */
function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    function check() {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (tab.status === 'complete') { resolve(); return; }
        setTimeout(check, 200);
      });
    }
    check();
  });
}

async function ensureBridgeTab() {
  if (bridgeTabId !== null) {
    try {
      const tab = await chrome.tabs.get(bridgeTabId);
      if (tab) return bridgeTabId;
    } catch (e) { bridgeTabId = null; }
  }
  const existing = (await chrome.tabs.query({ url: 'https://9gag.com/*' }))
    .filter(t => t.id !== pendingLoginTabId);
  let tab = existing[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: 'https://9gag.com/', active: false });
    await waitForTabComplete(tab.id);
  } else if (tab.status !== 'complete') {
    await waitForTabComplete(tab.id);
  }
  bridgeTabId = tab.id;
  return bridgeTabId;
}

// Spúšťame v kontexte stránky (MAIN), aby požiadavky na comment.9gag.com išli presne ako
// z webu 9GAG — z izolovaného sveta content scriptu sa komentáre nenačítali.
async function exec(tabId, func, args) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: args || [],
    world: 'MAIN'
  });
  return result;
}

async function loadIdentity() {
  await ensureBridgeTab();
  identity = await exec(bridgeTabId, __ng_getIdentity);
  if (!commentOptions) {
    const opts = await exec(bridgeTabId, __ng_getCommentOptions).catch(() => null);
    commentOptions = (opts && opts.appId && opts.host) ? opts : DEFAULT_COMMENT_OPTIONS;
  }
  return identity;
}

/* ---------- správa účtov cez cookies ---------- */
const GAG_COOKIE_DOMAIN = '9gag.com';
let pendingLoginTabId = null;
let pendingLoginPoll = null;

async function getGagCookies() {
  return chrome.cookies.getAll({ domain: GAG_COOKIE_DOMAIN });
}

function cookieToUrl(c) {
  const domain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
  return `https://${domain}${c.path}`;
}

async function clearGagCookies() {
  const cookies = await getGagCookies();
  for (const c of cookies) {
    await chrome.cookies.remove({ url: cookieToUrl(c), name: c.name, storeId: c.storeId });
  }
}

async function restoreCookies(cookies) {
  for (const c of cookies) {
    const details = {
      url: cookieToUrl(c),
      name: c.name,
      value: c.value,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      storeId: c.storeId
    };
    if (!c.hostOnly) details.domain = c.domain;
    if (!c.session && c.expirationDate) details.expirationDate = c.expirationDate;
    await chrome.cookies.set(details);
  }
}

async function activateAccount(username) {
  const { accounts = {} } = await chrome.storage.local.get('accounts');
  const acc = accounts[username];
  if (!acc) return;

  setStatus('Prepínam na účet @' + username + '...');
  await clearGagCookies();
  await restoreCookies(acc.cookies);
  await chrome.storage.local.set({ activeAccount: username });

  items = [];
  identity = null;
  renderTable();
  document.getElementById('filterRow').hidden = true;
  document.getElementById('actionRow').hidden = true;

  try {
    await loadIdentity();
    log('Prepnuté na účet @' + identity.name + '.');
    setStatus('Aktívny účet: @' + identity.name);
  } catch (e) {
    log('CHYBA pri prepnutí na @' + username + ': ' + e.message);
    setStatus('Chyba pri prepnutí účtu: ' + e.message);
  }
  await refreshAccountUI();
}

function stopLoginPoll() {
  if (pendingLoginPoll) { clearInterval(pendingLoginPoll); pendingLoginPoll = null; }
}

function setAddAccountUIWaiting(waiting) {
  document.getElementById('addAccountBtn').hidden = waiting;
  document.getElementById('cancelLoginBtn').hidden = !waiting;
  document.getElementById('loginHint').hidden = !waiting;
}

function cancelPendingLogin(reason) {
  stopLoginPoll();
  if (pendingLoginTabId) {
    chrome.tabs.remove(pendingLoginTabId).catch(() => {});
    pendingLoginTabId = null;
  }
  setAddAccountUIWaiting(false);
  setStatus(reason || 'Čakanie na prihlásenie zrušené.');
}

async function addAccount() {
  if (pendingLoginTabId) return;

  setAddAccountUIWaiting(true);
  setStatus('Odhlasujem aktuálny účet na 9GAG, aby šlo prihlásiť nový...');
  // Bez vyčistenia cookies by 9GAG na /login presmeroval späť na už prihláseného používateľa.
  await clearGagCookies();
  identity = null;
  bridgeTabId = null;
  await refreshAccountUI();

  // Kontrolu identity robíme cez samostatnú bridge kartu, nie cez prihlasovaciu kartu,
  // ktorá sa počas prihlasovania presmerováva a skript v nej nemusí dobehnúť.
  await ensureBridgeTab();

  const tab = await chrome.tabs.create({ url: 'https://9gag.com/login', active: true });
  pendingLoginTabId = tab.id;
  log('Otvorená karta na prihlásenie na 9GAG (tab ' + tab.id + '). Prihlás sa PRESNE v nej — účet sa zachytí automaticky.');
  setStatus('Čakám, kým sa prihlásiš v novootvorenej karte... (pokus 0)');

  let attempts = 0;
  const maxAttempts = 150; // ~5 min pri intervale 2 s

  pendingLoginPoll = setInterval(async () => {
    attempts++;
    const stillOpen = await chrome.tabs.get(pendingLoginTabId).catch(() => null);
    if (!stillOpen) {
      cancelPendingLogin('Karta na prihlásenie bola zatvorená, zrušené.');
      return;
    }
    try {
      const id = await exec(bridgeTabId, __ng_getIdentity);
      stopLoginPoll();
      const cookies = await getGagCookies();
      const { accounts = {} } = await chrome.storage.local.get('accounts');
      accounts[id.name] = { cookies, savedAt: Date.now() };
      await chrome.storage.local.set({ accounts, activeAccount: id.name });
      identity = id;
      await chrome.tabs.remove(pendingLoginTabId).catch(() => {});
      pendingLoginTabId = null;
      setAddAccountUIWaiting(false);
      log('Uložený nový účet: @' + id.name);
      setStatus('Účet @' + id.name + ' uložený a aktivovaný.');
      await refreshAccountUI();
    } catch (e) {
      if (attempts >= maxAttempts) {
        cancelPendingLogin('Vypršal čas na prihlásenie (5 min). Naposledy: ' + e.message);
        log('Prihlásenie sa nepodarilo zachytiť do 5 minút. Posledná chyba: ' + e.message);
        return;
      }
      setStatus('Čakám na prihlásenie v novej karte... (pokus ' + attempts + '/' + maxAttempts + ', zatiaľ neprihlásený)');
      if (attempts % 5 === 0) {
        log('Stále čakám na prihlásenie (pokus ' + attempts + '). Dôvod: ' + e.message);
      }
    }
  }, 2000);
}

async function refreshAccountUI() {
  const { accounts = {}, activeAccount } = await chrome.storage.local.get(['accounts', 'activeAccount']);
  const currentName = identity ? identity.name : activeAccount;
  const list = document.getElementById('accountList');
  list.innerHTML = '';

  const names = Object.keys(accounts);
  if (!names.length) {
    const empty = document.createElement('div');
    empty.className = 'account-empty';
    empty.textContent = 'Zatiaľ žiadny uložený účet.';
    list.appendChild(empty);
  } else {
    for (const name of names) {
      const row = document.createElement('button');
      row.className = 'account-row' + (name === currentName ? ' active' : '');
      row.textContent = '@' + name + (name === currentName ? ' ✓' : '');
      row.addEventListener('click', () => { activateAccount(name); document.getElementById('accountMenu').hidden = true; });
      list.appendChild(row);
    }
  }

  document.getElementById('identityBtn').textContent = (currentName ? '@' + currentName : 'Neprihlásený') + ' ▾';
}

/* ---------- funkcie spúšťané v kontexte 9gag tabu ---------- */
function __ng_getCommentOptions() {
  const c = window._config && window._config.config && window._config.config.commentOptions;
  return c ? { appId: c.appId, host: c.host, cdnHost: c.cdnHost } : null;
}

async function __ng_getIdentity() {
  const res = await fetch('/v1/user-info', {
    method: 'POST',
    credentials: 'include',
    headers: { 'x-api-version': '2' }
  });
  if (res.status === 401) throw new Error('Nie si prihlásený na 9GAG.');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const user = json && json.data && json.data.user;
  if (!user || !user.username) throw new Error('Nie si prihlásený na 9GAG.');
  if (!user.commentAuth) throw new Error('9GAG nevrátil commentAuth token pre komentáre.');
  return { name: user.username, accountId: String(user.accountId), commentAuth: user.commentAuth };
}

// Jedna strana postov, pod ktorými používateľ komentoval (záložka „Comments“ na profile).
async function __ng_fetchCommentedPosts(username, cursor) {
  const url = '/v1/user-posts/username/' + encodeURIComponent(username) + '/type/comments' + (cursor ? '?' + cursor : '');
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'x-api-version': '2' }
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const data = json.data || {};
  return {
    posts: (data.posts || []).map(p => ({ id: p.id, title: p.title || '', url: p.url })),
    nextCursor: data.nextCursor || null
  };
}

// Prejde všetky komentáre (aj odpovede) pod jedným postom a vráti tie od daného accountId.
async function __ng_scanPost(opts, postUrl, accountId, maxPages) {
  async function list(params) {
    const res = await fetch('https://' + opts.host + '/v2/comment-list.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (json.status === 'ERROR') throw new Error(json.error || json.code || 'chyba comment API');
    return json.payload || {};
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const mine = [];
  const authors = new Set(); // diagnostika: accountId autorov, ak by sa nič nenašlo
  let scanned = 0;
  let pages = 0;
  let truncated = false;

  function collect(comments) {
    for (const c of comments || []) {
      scanned++;
      if (c.user && authors.size < 5) authors.add(c.user.displayName + '=' + c.user.accountId);
      if (c.user && String(c.user.accountId) === accountId && !c.isDeleted) {
        mine.push({
          commentId: c.commentId,
          level: c.level,
          text: c.text || c.mediaText || '',
          type: c.type,
          timestamp: c.timestamp,
          likeCount: c.likeCount || 0,
          dislikeCount: c.dislikeCount || 0,
          permalink: c.permalink || ''
        });
      }
    }
  }

  // Najprv koreňové komentáre, pri každom s odpoveďami aj jeho vlákno.
  let params = { appId: opts.appId, url: postUrl, count: '50', type: 'old' };
  while (params) {
    if (pages >= maxPages) { truncated = true; break; }
    const page = await list(params);
    pages++;
    collect(page.comments);
    for (const c of page.comments || []) {
      if (!c.childrenTotal || !c.childrenUrl) continue;
      let childParams = Object.fromEntries(new URLSearchParams(c.childrenUrl));
      childParams.count = '50';
      // Vlákna sa do limitu strán nerátajú — inak by sa pri veľkých postoch
      // limit minul na odpovede skôr, než by sa prešli všetky koreňové komentáre.
      while (childParams) {
        const child = await list(childParams);
        collect(child.comments);
        childParams = child.next ? Object.fromEntries(new URLSearchParams(child.next)) : null;
        await sleep(150);
      }
    }
    params = page.next ? Object.fromEntries(new URLSearchParams(page.next)) : null;
    await sleep(150);
  }
  return { comments: mine, pages, truncated, scanned, authors: [...authors] };
}

async function __ng_deleteComment(opts, auth, commentId, postUrl) {
  const res = await fetch('https://' + opts.host + '/v1/comment.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ appId: opts.appId, auth, _method: 'DELETE', id: commentId, url: postUrl })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json().catch(() => null);
  if (json && json.status === 'ERROR') throw new Error(json.error || json.code || 'chyba pri mazaní');
  return true;
}

/* ---------- načítanie obsahu ---------- */
function mapComment(c, post) {
  return {
    kind: c.level > 1 ? 'reply' : 'comment',
    commentId: c.commentId,
    postUrl: post.url,
    postTitle: post.title || post.id,
    created: c.timestamp * 1000,
    score: c.likeCount - c.dislikeCount,
    permalink: (c.permalink || post.url).replace(/^http:/, 'https:'),
    snippet: c.text || (c.type && c.type !== 'text' ? '(' + c.type + ')' : ''),
    selected: false,
    status: 'pending'
  };
}

async function loadAll() {
  const loadBtn = document.getElementById('loadBtn');
  const stopBtn = document.getElementById('stopLoadBtn');
  loadBtn.disabled = true;
  stopBtn.hidden = false;
  stopLoading = false;
  const maxPages = Math.max(1, parseInt(document.getElementById('maxPagesInput').value, 10) || 40);
  try {
    setStatus('Pripájam sa na 9GAG...');
    await loadIdentity();
    await refreshAccountUI();

    setStatus('Načítavam posty, pod ktorými si komentoval...');
    const posts = [];
    const seen = new Set();
    let cursor = null;
    let guard = 0;
    do {
      const page = await exec(bridgeTabId, __ng_fetchCommentedPosts, [identity.name, cursor]);
      for (const p of page.posts) {
        if (!seen.has(p.id)) { seen.add(p.id); posts.push(p); }
      }
      cursor = page.nextCursor;
      setStatus('Načítaných postov s tvojimi komentármi: ' + posts.length);
      guard++;
      if (cursor) await sleep(500);
    } while (cursor && guard < 500 && !stopLoading);
    log('Nájdených ' + posts.length + ' postov, pod ktorými komentoval @' + identity.name + ' (accountId ' + identity.accountId + ').');

    items = [];
    renderTable();
    document.getElementById('filterRow').hidden = false;
    document.getElementById('actionRow').hidden = false;

    for (let i = 0; i < posts.length && !stopLoading; i++) {
      const post = posts[i];
      setStatus(`Prechádzam komentáre v poste ${i + 1}/${posts.length} (nájdených tvojich: ${items.length})...`);
      try {
        const res = await exec(bridgeTabId, __ng_scanPost, [commentOptions, post.url, identity.accountId, maxPages]);
        for (const c of res.comments) items.push(mapComment(c, post));
        log('Post ' + post.id + ': prehľadaných ' + res.scanned + ' komentárov (' + res.pages + ' strán), tvojich ' + res.comments.length +
          (res.comments.length ? '' : '. Vzorka autorov: ' + res.authors.join(', ')));
        if (res.truncated) {
          log('Pozor: post „' + (post.title || post.id) + '“ má viac než ' + maxPages + ' strán komentárov — prehľadaná len časť.');
        }
        if (res.comments.length) {
          sortItems();
          renderTable();
        }
      } catch (e) {
        log('CHYBA pri prechádzaní postu ' + post.id + ': ' + e.message);
      }
      await sleep(300);
    }

    sortItems();
    renderTable();
    const msg = (stopLoading ? 'Zastavené. ' : 'Hotovo. ') + 'Načítaných ' + items.length + ' komentárov.';
    setStatus(msg);
    log(msg);
  } catch (e) {
    setStatus('Chyba: ' + e.message);
    log('CHYBA pri načítaní: ' + e.message);
  } finally {
    loadBtn.disabled = false;
    stopBtn.hidden = true;
  }
}

/* ---------- triedenie a render ---------- */
const SORT_ACCESSORS = {
  kind: item => item.kind,
  created: item => item.created,
  post: item => item.postTitle.toLowerCase(),
  score: item => item.score,
  snippet: item => (item.snippet || '').toLowerCase(),
  status: item => item.status
};

function compareValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortItems() {
  const accessor = SORT_ACCESSORS[sortKey] || SORT_ACCESSORS.created;
  items.sort((a, b) => {
    const cmp = compareValues(accessor(a), accessor(b));
    return sortDesc ? -cmp : cmp;
  });
}

function updateSortIndicators() {
  document.querySelectorAll('#itemsTable thead th[data-sort-key]').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
    if (th.dataset.sortKey === sortKey) {
      arrow.textContent = sortDesc ? ' ↓' : ' ↑';
      th.classList.add('sorted');
    } else {
      arrow.textContent = '';
      th.classList.remove('sorted');
    }
  });
}

function renderTable() {
  const body = document.getElementById('itemsBody');
  const emptyState = document.getElementById('emptyState');
  body.innerHTML = '';

  if (!items.length) {
    emptyState.hidden = false;
  } else {
    emptyState.hidden = true;
    for (const item of items) {
      const tr = document.createElement('tr');

      const tdCheck = document.createElement('td');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = item.selected;
      cb.disabled = item.status !== 'pending';
      cb.addEventListener('change', () => { item.selected = cb.checked; updateSelectedCount(); });
      tdCheck.appendChild(cb);

      const tdType = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'badge ' + item.kind;
      badge.textContent = item.kind === 'reply' ? 'odpoveď' : 'komentár';
      tdType.appendChild(badge);

      const tdDate = document.createElement('td');
      tdDate.textContent = formatDateTime(item.created);

      const tdPost = document.createElement('td');
      tdPost.className = 'snippet';
      tdPost.title = item.postTitle;
      tdPost.textContent = item.postTitle;

      const tdScore = document.createElement('td');
      tdScore.className = 'score ' + (item.score > 0 ? 'score-positive' : item.score < 0 ? 'score-negative' : 'score-zero');
      tdScore.textContent = (item.score > 0 ? '+' : '') + item.score;

      const tdSnippet = document.createElement('td');
      tdSnippet.className = 'snippet';
      const snippetLink = document.createElement('a');
      snippetLink.href = item.permalink;
      snippetLink.target = '_blank';
      snippetLink.rel = 'noopener noreferrer';
      snippetLink.title = item.snippet;
      snippetLink.textContent = item.snippet || '(bez textu)';
      tdSnippet.appendChild(snippetLink);

      const tdStatus = document.createElement('td');
      tdStatus.className = 'status-' + item.status;
      tdStatus.textContent = statusLabel(item.status);

      tr.append(tdCheck, tdType, tdDate, tdPost, tdScore, tdSnippet, tdStatus);
      body.appendChild(tr);
    }
  }
  updateSelectedCount();
  updateSortIndicators();
}

function statusLabel(s) {
  switch (s) {
    case 'pending': return 'čaká';
    case 'processing': return 'spracúva sa...';
    case 'done': return 'zmazané';
    case 'error': return 'chyba';
    case 'skipped': return 'preskočené';
    default: return s;
  }
}

function updateSelectedCount() {
  const n = items.filter(i => i.selected && i.status === 'pending').length;
  document.getElementById('selectedCount').textContent = 'Vybraných: ' + n;
  document.getElementById('deleteBtn').disabled = n === 0 || processing;
}

/* ---------- výberové nástroje ---------- */
function selectAll(v) {
  items.forEach(i => { if (i.status === 'pending') i.selected = v; });
  renderTable();
}

function selectLastN(n) {
  const sorted = [...items].sort((a, b) => b.created - a.created);
  let count = 0;
  for (const item of sorted) {
    if (count >= n) break;
    if (item.status === 'pending') { item.selected = true; count++; }
  }
  renderTable();
}

function selectOlderThanMs(ms) {
  const cutoff = Date.now() - ms;
  items.forEach(i => { if (i.status === 'pending' && i.created <= cutoff) i.selected = true; });
  renderTable();
}

function invertSelection() {
  items.forEach(i => { if (i.status === 'pending') i.selected = !i.selected; });
  renderTable();
}

function selectDateRange(fromTs, toTs) {
  items.forEach(i => { if (i.status === 'pending' && i.created >= fromTs && i.created <= toTs) i.selected = true; });
  renderTable();
}

/* ---------- zmazanie ---------- */
async function processSelected() {
  processing = true;
  const selected = items.filter(i => i.selected && i.status === 'pending');
  log('Spúšťam mazanie ' + selected.length + ' komentárov.');

  try {
    await loadIdentity(); // čerstvý commentAuth token
  } catch (e) {
    log('CHYBA: nepodarilo sa overiť prihlásenie: ' + e.message);
    processing = false;
    return;
  }

  for (const item of selected) {
    item.status = 'processing';
    renderTable();
    try {
      await exec(bridgeTabId, __ng_deleteComment, [commentOptions, identity.commentAuth, item.commentId, item.postUrl]);
      item.status = 'done';
      log('OK: ' + (item.kind === 'reply' ? 'odpoveď' : 'komentár') + ' pod „' + item.postTitle + '“ (' + formatDateTime(item.created) + ') zmazaný.');
    } catch (e) {
      item.status = 'error';
      log('CHYBA (' + item.commentId + '): ' + e.message);
    }
    renderTable();
    await sleep(1100);
  }

  processing = false;
  log('Spracovanie dokončené.');
  setStatus('Spracovanie dokončené.');
}

/* ---------- UI eventy ---------- */
document.getElementById('loadBtn').addEventListener('click', loadAll);
document.getElementById('stopLoadBtn').addEventListener('click', () => {
  stopLoading = true;
  setStatus('Zastavujem načítanie...');
});

document.querySelectorAll('#itemsTable thead th[data-sort-key]').forEach(th => {
  th.addEventListener('click', () => {
    const key = th.dataset.sortKey;
    if (sortKey === key) {
      sortDesc = !sortDesc;
    } else {
      sortKey = key;
      sortDesc = true;
    }
    sortItems();
    renderTable();
  });
});

document.querySelectorAll('.quick-select').forEach(btn => {
  btn.addEventListener('click', () => selectOlderThanMs(Number(btn.dataset.ms)));
});

document.getElementById('lastNBtn').addEventListener('click', () => {
  const n = parseInt(document.getElementById('lastNInput').value, 10);
  if (n > 0) selectLastN(n);
});

document.getElementById('dateRangeBtn').addEventListener('click', () => {
  const fromVal = document.getElementById('dateFrom').value;
  const toVal = document.getElementById('dateTo').value;
  if (!fromVal && !toVal) return;
  const fromTs = fromVal ? new Date(fromVal + 'T00:00:00').getTime() : -Infinity;
  const toTs = toVal ? new Date(toVal + 'T23:59:59').getTime() : Infinity;
  selectDateRange(fromTs, toTs);
});

document.getElementById('selectAllBtn').addEventListener('click', () => selectAll(true));
document.getElementById('clearSelBtn').addEventListener('click', () => selectAll(false));
document.getElementById('invertSelBtn').addEventListener('click', invertSelection);

document.getElementById('masterCheck').addEventListener('change', (e) => selectAll(e.target.checked));

/* potvrdzovací modál */
const modal = document.getElementById('confirmModal');
const confirmOk = document.getElementById('confirmOk');

document.getElementById('deleteBtn').addEventListener('click', () => {
  const n = items.filter(i => i.selected && i.status === 'pending').length;
  if (!n) return;
  document.getElementById('confirmText').textContent = `Naozaj chceš natrvalo zmazať ${n} komentárov?`;
  modal.hidden = false;
  confirmOk.focus();
});

document.getElementById('confirmCancel').addEventListener('click', () => { modal.hidden = true; });

confirmOk.addEventListener('click', async () => {
  modal.hidden = true;
  document.getElementById('deleteBtn').disabled = true;
  await processSelected();
  updateSelectedCount();
});

/* identity dropdown */
const identityBtn = document.getElementById('identityBtn');
const accountMenu = document.getElementById('accountMenu');

identityBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  accountMenu.hidden = !accountMenu.hidden;
});

document.addEventListener('click', (e) => {
  if (!accountMenu.hidden && !accountMenu.contains(e.target) && e.target !== identityBtn) {
    accountMenu.hidden = true;
  }
});

document.getElementById('addAccountBtn').addEventListener('click', addAccount);
document.getElementById('cancelLoginBtn').addEventListener('click', () => cancelPendingLogin('Čakanie na prihlásenie zrušené.'));

renderTable();
refreshAccountUI();
