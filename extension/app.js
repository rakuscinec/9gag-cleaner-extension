'use strict';

/* ---------- state ---------- */
let bridgeTabId = null;
let identity = null;      // { name, accountId, commentAuth }
let commentOptions = null; // { appId, host, cdnHost }
let items = [];           // list of comments
let sortKey = 'created';
let sortDesc = true;
let processing = false;
let stopLoading = false;
let loggedOut = false;    // the startup session check found that nobody is signed in

// Fallback in case window._config cannot be read from 9gag.com
const DEFAULT_COMMENT_OPTIONS = {
  appId: 'a_dd8f2b7d304a10edaf6f29517ea0ca4100a43d1b',
  host: 'comment.9gag.com',
  cdnHost: 'comment-cdn.9gag.com'
};

/* ---------- helpers ---------- */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pad2(n) { return String(n).padStart(2, '0'); }

// Format: YYYY-MM-DD HH:MM:SS
function formatDateTime(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
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

// Runs in the page context (MAIN) so requests to comment.9gag.com behave exactly like
// those made by the 9GAG website — from the content script's isolated world, comments did not load.
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
  loggedOut = false;
  if (!commentOptions) {
    const opts = await exec(bridgeTabId, __ng_getCommentOptions).catch(() => null);
    commentOptions = (opts && opts.appId && opts.host) ? opts : DEFAULT_COMMENT_OPTIONS;
  }
  return identity;
}

/* ---------- account management via cookies ---------- */
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

  setStatus('Switching to account @' + username + '...');
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
    log('Switched to account @' + identity.name + '.');
    setStatus('Active account: @' + identity.name);
  } catch (e) {
    log('ERROR switching to @' + username + ': ' + e.message);
    setStatus('Error switching account: ' + e.message);
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
  setStatus(reason || 'Waiting for sign-in cancelled.');
}

async function addAccount() {
  if (pendingLoginTabId) return;

  setAddAccountUIWaiting(true);
  setStatus('Signing out of the current 9GAG account so a new one can sign in...');
  // Without clearing cookies, 9GAG would redirect /login back to the already signed-in user.
  await clearGagCookies();
  identity = null;
  bridgeTabId = null;
  await refreshAccountUI();

  // Identity is checked through a separate bridge tab, not the sign-in tab, which
  // redirects during sign-in and a script in it might not finish.
  await ensureBridgeTab();

  const tab = await chrome.tabs.create({ url: 'https://9gag.com/login', active: true });
  pendingLoginTabId = tab.id;
  log('Opened a 9GAG sign-in tab (tab ' + tab.id + '). Sign in in EXACTLY that tab — the account will be detected automatically.');
  setStatus('Waiting for you to sign in in the newly opened tab... (attempt 0)');

  let attempts = 0;
  const maxAttempts = 150; // ~5 min at a 2 s interval

  pendingLoginPoll = setInterval(async () => {
    attempts++;
    const stillOpen = await chrome.tabs.get(pendingLoginTabId).catch(() => null);
    if (!stillOpen) {
      cancelPendingLogin('The sign-in tab was closed, cancelled.');
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
      log('Saved new account: @' + id.name);
      setStatus('Account @' + id.name + ' saved and activated.');
      await refreshAccountUI();
    } catch (e) {
      if (attempts >= maxAttempts) {
        cancelPendingLogin('Sign-in timed out (5 min). Last error: ' + e.message);
        log('Could not detect a sign-in within 5 minutes. Last error: ' + e.message);
        return;
      }
      setStatus('Waiting for sign-in in the new tab... (attempt ' + attempts + '/' + maxAttempts + ', not signed in yet)');
      if (attempts % 5 === 0) {
        log('Still waiting for sign-in (attempt ' + attempts + '). Reason: ' + e.message);
      }
    }
  }, 2000);
}

async function refreshAccountUI() {
  const { accounts = {}, activeAccount } = await chrome.storage.local.get(['accounts', 'activeAccount']);
  // If the session check failed, don't show the last active saved account as signed in.
  const currentName = identity ? identity.name : (loggedOut ? null : activeAccount);
  const list = document.getElementById('accountList');
  list.innerHTML = '';

  const names = Object.keys(accounts);
  if (!names.length) {
    const empty = document.createElement('div');
    empty.className = 'account-empty';
    empty.textContent = 'No saved accounts yet.';
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

  document.getElementById('identityBtn').textContent = (currentName ? '@' + currentName : 'Not signed in') + ' ▾';
}

/* ---------- functions executed in the 9gag tab ---------- */
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
  if (res.status === 401) throw new Error('You are not signed in to 9GAG.');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const user = json && json.data && json.data.user;
  if (!user || !user.username) throw new Error('You are not signed in to 9GAG.');
  if (!user.commentAuth) throw new Error('9GAG did not return a commentAuth token for comments.');
  return { name: user.username, accountId: String(user.accountId), commentAuth: user.commentAuth };
}

// One page of posts the user has commented on (the "Comments" tab on the profile).
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
    posts: (data.posts || []).map(p => ({ id: p.id, title: p.title || '', url: p.url, commentsCount: p.commentsCount || 0 })),
    nextCursor: data.nextCursor || null
  };
}

// Walks all comments (including replies) under one post and returns those by the given accountId.
async function __ng_scanPost(opts, postUrl, accountId, maxPages, threadConcurrency) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // On 429 / 5xx, retry with an increasing delay so parallel requests don't fail the whole post.
  async function list(params) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch('https://' + opts.host + '/v2/comment-list.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params)
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (json.status === 'ERROR') throw new Error(json.error || json.code || 'comment API error');
      return json.payload || {};
    }
  }
  const mine = [];
  let scanned = 0;
  let pages = 0;
  let truncated = false;

  function collect(comments) {
    for (const c of comments || []) {
      scanned++;
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

  async function scanThread(childrenUrl) {
    let childParams = Object.fromEntries(new URLSearchParams(childrenUrl));
    childParams.count = '50';
    while (childParams) {
      const child = await list(childParams);
      collect(child.comments);
      childParams = child.next ? Object.fromEntries(new URLSearchParams(child.next)) : null;
    }
  }

  // Top-level comments are paged sequentially (cursor); their reply threads load in parallel
  // and alongside the next page. Threads don't count toward the page limit — otherwise on
  // large posts the limit would be used up on replies before all top-level comments were read.
  const threadUrls = [];
  let rootsDone = false;
  async function threadWorker() {
    while (true) {
      const url = threadUrls.shift();
      if (url) { await scanThread(url); continue; }
      if (rootsDone) return;
      await sleep(50);
    }
  }
  const workers = Array.from({ length: threadConcurrency }, threadWorker);

  try {
    let params = { appId: opts.appId, url: postUrl, count: '50', type: 'old' };
    while (params) {
      if (pages >= maxPages) { truncated = true; break; }
      const page = await list(params);
      pages++;
      collect(page.comments);
      for (const c of page.comments || []) {
        if (c.childrenTotal && c.childrenUrl) threadUrls.push(c.childrenUrl);
      }
      params = page.next ? Object.fromEntries(new URLSearchParams(page.next)) : null;
    }
  } finally {
    rootsDone = true;
  }
  await Promise.all(workers);
  return { comments: mine, pages, truncated, scanned };
}

async function __ng_deleteComment(opts, auth, commentId, postUrl) {
  const res = await fetch('https://' + opts.host + '/v1/comment.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ appId: opts.appId, auth, _method: 'DELETE', id: commentId, url: postUrl })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json().catch(() => null);
  if (json && json.status === 'ERROR') throw new Error(json.error || json.code || 'delete failed');
  return true;
}

/* ---------- loading content ---------- */
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

/* ---------- progress ---------- */
let progress = null;
let renderTimer = null;

// Re-render the table at most once per second — with parallel scanning, comments arrive
// from several posts at once and a full re-render is expensive.
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    sortItems();
    renderTable();
  }, 1000);
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min ' + pad2(s % 60) + ' s';
  return Math.floor(m / 60) + ' h ' + pad2(m % 60) + ' min';
}

function renderProgress() {
  const wrap = document.getElementById('progressWrap');
  if (!progress) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const p = progress;
  // Weighted by each post's comment count (as reported by 9GAG), not by number of posts — large posts take longer.
  const ratio = p.commentsKnown ? Math.min(1, p.commentsDone / p.commentsKnown) : 0;
  document.getElementById('progressFill').style.width = (p.finished ? 100 : ratio * 100).toFixed(1) + '%';

  const elapsed = Date.now() - p.startTs;
  let eta;
  if (p.finished) {
    eta = 'Done in ' + formatDuration(elapsed);
  } else if (p.commentsDone > 0 && elapsed > 3000) {
    const rate = p.commentsDone / elapsed;
    const remaining = (p.commentsKnown - p.commentsDone) / rate;
    eta = (p.listingDone ? '~' : 'At least ~') + formatDuration(remaining) + ' left';
  } else {
    eta = 'Estimating time...';
  }

  document.getElementById('progressText').textContent =
    `Posts: ${p.postsDone}/${p.postsFound}${p.listingDone ? '' : '+ (still loading the list)'}` +
    ` · Comments: ${p.commentsDone.toLocaleString('en')}/${p.commentsKnown.toLocaleString('en')}` +
    ` · Yours: ${items.length}`;
  document.getElementById('progressEta').textContent = eta;
}

async function loadAll() {
  const loadBtn = document.getElementById('loadBtn');
  const stopBtn = document.getElementById('stopLoadBtn');
  loadBtn.disabled = true;
  stopBtn.hidden = false;
  stopLoading = false;
  const maxPages = Math.max(1, parseInt(document.getElementById('maxPagesInput').value, 10) || 40);
  const postConcurrency = Math.min(10, Math.max(1, parseInt(document.getElementById('concurrencyInput').value, 10) || 4));
  const threadConcurrency = 4;
  let progressTimer = null;
  try {
    setStatus('Connecting to 9GAG...');
    await loadIdentity();
    await refreshAccountUI();

    items = [];
    renderTable();
    document.getElementById('filterRow').hidden = false;
    document.getElementById('actionRow').hidden = false;

    progress = {
      startTs: Date.now(), postsFound: 0, postsDone: 0,
      commentsKnown: 0, commentsDone: 0, listingDone: false, finished: false
    };
    progressTimer = setInterval(renderProgress, 500);
    renderProgress();
    setStatus('Searching for your comments...');

    // Producer: pages through the list of posts and queues them right away, so workers
    // start scanning from the very first page.
    const queue = [];
    const seen = new Set();
    let listingError = null;
    const producer = (async () => {
      let cursor = null;
      let guard = 0;
      try {
        do {
          const page = await exec(bridgeTabId, __ng_fetchCommentedPosts, [identity.name, cursor]);
          for (const p of page.posts) {
            if (seen.has(p.id)) continue;
            seen.add(p.id);
            queue.push(p);
            progress.postsFound++;
            progress.commentsKnown += p.commentsCount;
          }
          cursor = page.nextCursor;
          guard++;
        } while (cursor && guard < 500 && !stopLoading);
      } catch (e) {
        listingError = e;
        log('ERROR loading the list of posts: ' + e.message);
      } finally {
        progress.listingDone = true;
      }
    })();

    async function worker() {
      while (!stopLoading) {
        const post = queue.shift();
        if (!post) {
          if (progress.listingDone) return;
          await sleep(100);
          continue;
        }
        try {
          const res = await exec(bridgeTabId, __ng_scanPost, [commentOptions, post.url, identity.accountId, maxPages, threadConcurrency]);
          for (const c of res.comments) items.push(mapComment(c, post));
          if (res.comments.length) {
            log('Post ' + post.id + ': ' + res.comments.length + ' of yours among ' + res.scanned + ' comments.');
            scheduleRender();
          }
          if (res.truncated) {
            log('Warning: post "' + (post.title || post.id) + '" has more than ' + maxPages + ' pages of comments — only part of it was scanned.');
          }
        } catch (e) {
          log('ERROR scanning post ' + post.id + ': ' + e.message);
        }
        progress.postsDone++;
        progress.commentsDone += post.commentsCount;
      }
    }

    await Promise.all([producer, ...Array.from({ length: postConcurrency }, worker)]);

    progress.finished = !stopLoading && !listingError;
    renderProgress();
    sortItems();
    renderTable();
    const msg = (stopLoading ? 'Stopped. ' : 'Done. ') + 'Scanned ' + progress.postsDone + ' posts, found ' + items.length + ' of your comments.';
    setStatus(msg);
    log(msg);
  } catch (e) {
    setStatus('Error: ' + e.message);
    log('ERROR while loading: ' + e.message);
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    loadBtn.disabled = false;
    stopBtn.hidden = true;
  }
}

/* ---------- sorting and rendering ---------- */
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
      badge.textContent = item.kind === 'reply' ? 'reply' : 'comment';
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
      snippetLink.textContent = item.snippet || '(no text)';
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
    case 'pending': return 'pending';
    case 'processing': return 'processing...';
    case 'done': return 'deleted';
    case 'error': return 'error';
    case 'skipped': return 'skipped';
    default: return s;
  }
}

function updateSelectedCount() {
  const n = items.filter(i => i.selected && i.status === 'pending').length;
  document.getElementById('selectedCount').textContent = 'Selected: ' + n;
  document.getElementById('deleteBtn').disabled = n === 0 || processing;
}

/* ---------- selection tools ---------- */
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

/* ---------- deletion ---------- */
async function processSelected() {
  processing = true;
  const selected = items.filter(i => i.selected && i.status === 'pending');
  log('Starting deletion of ' + selected.length + ' comments.');

  try {
    await loadIdentity(); // fresh commentAuth token
  } catch (e) {
    log('ERROR: could not verify sign-in: ' + e.message);
    processing = false;
    return;
  }

  for (const item of selected) {
    item.status = 'processing';
    renderTable();
    try {
      await exec(bridgeTabId, __ng_deleteComment, [commentOptions, identity.commentAuth, item.commentId, item.postUrl]);
      item.status = 'done';
      log('OK: ' + item.kind + ' on "' + item.postTitle + '" (' + formatDateTime(item.created) + ') deleted.');
    } catch (e) {
      item.status = 'error';
      log('ERROR (' + item.commentId + '): ' + e.message);
    }
    renderTable();
    await sleep(1100);
  }

  processing = false;
  log('Processing finished.');
  setStatus('Processing finished.');
}

/* ---------- UI events ---------- */
document.getElementById('loadBtn').addEventListener('click', loadAll);
document.getElementById('stopLoadBtn').addEventListener('click', () => {
  stopLoading = true;
  setStatus('Stopping...');
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

/* confirmation modal */
const modal = document.getElementById('confirmModal');
const confirmOk = document.getElementById('confirmOk');

document.getElementById('deleteBtn').addEventListener('click', () => {
  const n = items.filter(i => i.selected && i.status === 'pending').length;
  if (!n) return;
  document.getElementById('confirmText').textContent = `Do you really want to permanently delete ${n} comment${n === 1 ? '' : 's'}?`;
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
document.getElementById('cancelLoginBtn').addEventListener('click', () => cancelPendingLogin('Waiting for sign-in cancelled.'));

// Check right after opening whether a 9GAG session is active, so the signed-in account
// shows in the top right without having to click "Load my comments".
async function checkSessionOnStart() {
  await refreshAccountUI();
  document.getElementById('identityBtn').textContent = 'Checking sign-in... ▾';
  setStatus('Checking 9GAG sign-in...');
  try {
    await loadIdentity();
    setStatus('Signed in as @' + identity.name + '.');
  } catch (e) {
    identity = null;
    loggedOut = true;
    setStatus('You are not signed in to 9GAG — sign in using the button in the top right.');
  }
  await refreshAccountUI();
}

renderTable();
checkSessionOnStart();
