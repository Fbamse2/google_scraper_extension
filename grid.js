const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => { const node = $(id); if (node) node.addEventListener(ev, fn); };
const setText = (id, txt) => { const node = $(id); if (node) node.textContent = txt; };
const storageGet = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
const storageSet = (obj) => new Promise((resolve) => chrome.storage.local.set(obj, resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

const sharedLib = globalThis.CollectorShared || {};
const deriveThumb = sharedLib.extractThumbnail;
const slugify = sharedLib.slugify;
const deduplicateImages = sharedLib.deduplicateImages;
const filterImages = sharedLib.filterImages;

const NO_IMAGE = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="250" height="200"><rect fill="#f0f0f0" width="250" height="200"/><text fill="#999" x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="14">No img</text></svg>'
)}`;

const DEFAULT_FOLDERS = [
  { id: 'root', name: 'All', parent: null },
  { id: 'removed', name: '🗑️ Trash', parent: null, hidden: true }
];

const state = {
  folderId: 'root',
  page: 1,
  perPage: 30,
  items: [],
  folders: [],
  selected: new Set(),
  search: '',
  sort: 'newest',
  favOnly: false,
  gifOnly: false,
  pageItems: [],
  lastIndex: null,
  dragged: null,
  viewCounts: { folders: 0, items: 0 },
  display: { gridSize: 250, imageHeight: 200, gap: 20, showUrls: true }
};

let settings = {};
const lightboxState = { index: -1 };
const magState = { enabled: false, zoom: 3 };
let slideshowTimer = null;
let toastTimer = null;
let verifyRunning = false;
let verifyQueueBusy = false;
let dupeClusters = [];

/* per-folder "group by page" state — each folder keeps its own grouping */
const pageGroup = { byFolder: {} };
let tempSeq = 0;

/* ---------------- storage ---------------- */

function ensureDefaultFolders() {
  if (!Array.isArray(state.folders) || !state.folders.length) {
    state.folders = JSON.parse(JSON.stringify(DEFAULT_FOLDERS));
  }
  if (!state.folders.some((f) => f.id === 'root')) {
    state.folders.unshift({ id: 'root', name: 'All', parent: null });
  }
  if (!state.folders.some((f) => f.id === 'removed')) {
    state.folders.push({ id: 'removed', name: '🗑️ Trash', parent: null, hidden: true });
  }
}

async function loadData() {
  const res = await storageGet(['collected_items', 'folders', 'collector_settings', 'display_settings']);

  console.log('[grid.js] loadData:', {
    itemsCount: res.collected_items?.length || 0,
    foldersCount: res.folders?.length || 0,
    settings: !!res.collector_settings,
    display: !!res.display_settings
  });
  state.items = Array.isArray(res.collected_items) ? res.collected_items : [];
  state.folders =
    Array.isArray(res.folders) && res.folders.length
      ? res.folders
      : JSON.parse(JSON.stringify(DEFAULT_FOLDERS));

  ensureDefaultFolders();
  settings = res.collector_settings || {};

  const display = res.display_settings || {};
  state.display = {
    gridSize: Number(display.gridSize) || 250,
    imageHeight: Number(display.imageHeight) || 200,
    gap: Number(display.gap) || 20,
    showUrls: display.showUrls !== false
  };
  state.perPage = Number(display.perPage) || 30;
}

async function saveData() {
  await storageSet({ collected_items: state.items, folders: state.folders });
}

async function saveDisplay() {
  await storageSet({ display_settings: { ...state.display, perPage: state.perPage } });
}

function saveViewState() {
  chrome.storage.local.set({
    grid_view_state: {
      folderId: state.folderId,
      page: state.page,
      search: state.search,
      sort: state.sort,
      favOnly: state.favOnly,
      gifOnly: state.gifOnly
    }
  });
}

async function restoreViewState() {
  const res = await storageGet(['grid_view_state']);
  const vs = res.grid_view_state || {};
  if (typeof vs.folderId === 'string') state.folderId = vs.folderId;
  if (Number.isInteger(vs.page) && vs.page > 0) state.page = vs.page;
  if (typeof vs.search === 'string') state.search = vs.search;
  if (vs.sort === 'newest' || vs.sort === 'oldest') state.sort = vs.sort;
  state.favOnly = !!vs.favOnly;
  state.gifOnly = !!vs.gifOnly;
}

/* ---------------- folder helpers ---------------- */

const getFolder = (id) => state.folders.find((f) => f.id === id);
const getItemCount = (folderId) => state.items.filter((i) => i.folder === folderId).length;

function getFolderPath(folderId) {
  if (folderId === 'root') return 'All';
  const path = [];
  let current = getFolder(folderId);
  while (current && current.id !== 'root') {
    path.unshift(current.name);
    current = current.parent ? getFolder(current.parent) : null;
  }
  return `All / ${path.join(' / ')}`;
}

function isDescendant(sourceId, targetId) {
  if (sourceId === targetId) return true;
  let current = getFolder(targetId);
  while (current) {
    if (current.id === sourceId) return true;
    current = current.parent ? getFolder(current.parent) : null;
  }
  return false;
}

function isInTrash(folderId) {
  let current = getFolder(folderId);
  while (current) {
    if (current.id === 'removed') return true;
    current = current.parent ? getFolder(current.parent) : null;
  }
  return false;
}

/* this folder + every subfolder beneath it (recursively), skipping trash */
function getFolderTreeIds(fid) {
  const ids = [fid];
  for (const c of state.folders.filter((f) => f.parent === fid && !f.hidden)) {
    ids.push(...getFolderTreeIds(c.id));
  }
  return ids;
}

function getTargetUrls(itemUrl) {
  return state.selected.has(itemUrl) ? [...state.selected] : [itemUrl];
}

function getThumb(item) {
  return item.thumb || deriveThumb(item.url) || item.directImage || NO_IMAGE;
}

const looksLikeGif = (item) => /\.gif(\?|#|$)/i.test(String(item.directImage || ''));

const isGifItem = (item) => {
  if (item.gifChecked) return item.isGif === true;
  return item.isGif === true || looksLikeGif(item);
};

/* ---------------- undo toast ---------------- */

function showToast(msg, undoFn) {
  const toast = $('toast');
  if (!toast) return;
  setText('toastMsg', msg);
  const undoBtn = $('toastUndo');
  undoBtn.style.display = undoFn ? '' : 'none';
  if (undoFn) undoBtn.onclick = () => { undoFn(); hideToast(); };
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 8000);
}

function hideToast() {
  const toast = $('toast');
  if (toast) toast.classList.remove('show');
}

/* ---------------- mutations (with undo) ---------------- */

async function removeItems(urls, permanent = false, confirmFirst = false) {
  if (!urls.length) return;

  if (confirmFirst) {
    const message = permanent
      ? `Delete ${urls.length} selected items permanently?`
      : `Remove ${urls.length} selected items?`;
    if (!confirm(message)) return;
  }

  const set = new Set(urls);

  if (permanent) {
    const deleted = state.items.filter((i) => set.has(i.url)).map((i) => ({ ...i }));
    state.items = state.items.filter((i) => !set.has(i.url));
    state.selected.clear();
    await saveData();
    render();
    showToast(`Deleted ${deleted.length} item${deleted.length !== 1 ? 's' : ''}`, () => {
      state.items = state.items.concat(deleted);
      saveData();
      render();
    });
  } else {
    const prev = state.items.filter((i) => set.has(i.url)).map((i) => ({ url: i.url, folder: i.folder }));
    state.items.forEach((i) => { if (set.has(i.url)) i.folder = 'removed'; });
    state.selected.clear();
    await saveData();
    render();
    showToast(`Moved ${prev.length} item${prev.length !== 1 ? 's' : ''} to Trash`, () => {
      prev.forEach((p) => {
        const it = state.items.find((i) => i.url === p.url);
        if (it) it.folder = p.folder;
      });
      saveData();
      render();
    });
  }
}

async function moveItems(urls, folderId) {
  const set = new Set(urls);
  const prev = state.items.filter((i) => set.has(i.url)).map((i) => ({ url: i.url, folder: i.folder }));

  state.items.forEach((i) => { if (set.has(i.url)) i.folder = folderId; });
  state.selected.clear();
  await saveData();
  render();

  const targetName = folderId === 'root' ? 'All' : (getFolder(folderId)?.name || folderId);
  showToast(`Moved ${prev.length} item${prev.length !== 1 ? 's' : ''} to "${targetName}"`, () => {
    prev.forEach((p) => {
      const it = state.items.find((i) => i.url === p.url);
      if (it) it.folder = p.folder;
    });
    saveData();
    render();
  });
}

async function moveFolder(folderId, targetParentId) {
  if (folderId === targetParentId) return;
  if (isDescendant(folderId, targetParentId)) return;
  const folder = getFolder(folderId);
  if (!folder) return;
  const prevParent = folder.parent;
  folder.parent = targetParentId;
  await saveData();
  render();
  showToast(`Moved folder "${folder.name}"`, () => {
    folder.parent = prevParent;
    saveData();
    render();
  });
}

/* ---------------- query folders (fully automatic) ---------------- */

function ensureQueryFolder(query) {
  const id = 'qf_' + slugify(query);
  let f = state.folders.find((x) => x.id === id);
  if (!f) {
    f = { id, name: query.slice(0, 40), parent: 'root' };
    state.folders.push(f);
  }
  return id;
}

function autoQueryOf(item) {
  try {
    const u = new URL(item.url);
    if (u.hostname.includes('google.com') && u.pathname === '/imgres') {
      const q = u.searchParams.get('q');
      if (q && q.trim()) return q.trim();
    }
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function moveToQueryFolder(urls) {
  const urlSet = new Set(urls);
  const targets = state.items.filter((i) => urlSet.has(i.url));
  if (!targets.length) return;

  const prev = targets.map((i) => ({ url: i.url, folder: i.folder }));

  const groups = new Map();
  let skipped = 0;
  for (const it of targets) {
    const q = autoQueryOf(it);
    if (!q) { skipped++; continue; }
    if (!groups.has(q)) groups.set(q, []);
    groups.get(q).push(it.url);
  }

  if (!groups.size) {
    showToast('No search query found in the selected items', null);
    return;
  }

  const names = [];
  let moved = 0;
  for (const [query, groupUrls] of groups) {
    const folderId = ensureQueryFolder(query);
    const set = new Set(groupUrls);
    state.items.forEach((i) => { if (set.has(i.url)) i.folder = folderId; });
    moved += groupUrls.length;
    names.push(query.length > 22 ? query.slice(0, 22) + '…' : query);
  }

  state.selected.clear();
  await saveData();
  render();

  const label = names.length === 1 ? `"${names[0]}"` : `${names.length} query folders`;
  showToast(`Sorted ${moved} item${moved !== 1 ? 's' : ''} into ${label}${skipped ? ` · ${skipped} skipped` : ''}`, () => {
    prev.forEach((p) => {
      const it = state.items.find((i) => i.url === p.url);
      if (it) it.folder = p.folder;
    });
    saveData();
    render();
  });
}

/* ---------------- group by page (by source website) ----------------
   🗂 This Folder  — groups the open folder's direct items
   🗂 Sub Folders  — groups the open folder + every subfolder (recursive)
   🗂 All Folders  — groups the entire library into the root (All)
   Grouping key = the source site the image came from (imgrefurl host).
   All grouping is temporary — ungrouping returns items to their folders. */

/* group key = the source site the image came from (imgrefurl host) */
function pageKeyOf(item) {
  try {
    const u = new URL(item.url);
    if (u.hostname.includes('google.com') && u.pathname === '/imgres') {
      const ref = u.searchParams.get('imgrefurl');
      if (ref) {
        try {
          const host = new URL(ref).hostname.replace(/^www\./, '');
          if (host) return { key: 'site:' + host, label: host };
        } catch {}
      }
      const q = u.searchParams.get('q');
      if (q) return { key: 'q:' + q.trim().toLowerCase(), label: 'Google: ' + q.trim() };
      return { key: 'google-images', label: 'Google Images' };
    }
    const host = u.hostname.replace(/^www\./, '');
    return { key: 'site:' + host, label: host };
  } catch {
    return { key: 'unknown', label: 'Unknown source' };
  }
}

function persistPageGroup() {
  return storageSet({ page_group_state: { byFolder: pageGroup.byFolder } });
}

async function restorePageGroupState() {
  const res = await storageGet(['page_group_state']);
  const saved = res.page_group_state && res.page_group_state.byFolder ? res.page_group_state.byFolder : {};
  pageGroup.byFolder = {};
  Object.keys(saved).forEach((fid) => {
    const g = saved[fid];
    if (!g || !Array.isArray(g.tempIds)) return;
    const liveTemps = g.tempIds.filter((id) => state.folders.some((f) => f.id === id));
    if (liveTemps.length) {
      pageGroup.byFolder[fid] = { restore: g.restore || {}, tempIds: liveTemps };
    }
  });
}

function updatePageGroupChip() {
  const hereBtn = $('pageGroupBtn');
  const subBtn = $('pageGroupSubBtn');
  const allBtn = $('pageGroupAllBtn');
  const allGrouped = !!pageGroup.byFolder['__all__'];
  const hereGrouped = !!pageGroup.byFolder[state.folderId];
  const subGrouped = !!pageGroup.byFolder['__sub__' + state.folderId];

  if (hereBtn) {
    hereBtn.classList.toggle('active', hereGrouped);
    hereBtn.textContent = hereGrouped ? '🗂 Ungroup' : '🗂 This Folder';
  }
  if (subBtn) {
    subBtn.classList.toggle('active', subGrouped);
    subBtn.textContent = subGrouped ? '🗂 Ungroup Subs' : '🗂 Sub Folders';
  }
  if (allBtn) {
    allBtn.classList.toggle('active', allGrouped);
    allBtn.textContent = allGrouped ? '🗂 Ungroup All' : '🗂 All Folders';
  }
}

function buildGroups(scope) {
  const groups = new Map();
  for (const it of scope) {
    const { key, label } = pageKeyOf(it);
    if (!groups.has(key)) groups.set(key, { label, items: [] });
    groups.get(key).items.push(it);
  }
  return groups;
}

/* group ONE folder's direct items; returns folders created (0 = skipped) */
async function groupOneFolder(fid) {
  const scope = state.items.filter((i) => i.folder === fid);
  console.log(`[ByPage] folder "${fid}" → ${scope.length} items`);
  if (!scope.length) return 0;

  const groups = buildGroups(scope);
  const summary = [...groups.values()].map((x) => `${x.label} (${x.items.length})`).join(', ');
  console.log(`[ByPage] folder "${fid}" → ${groups.size} source(s): ${summary}`);

  if (groups.size < 2) {
    console.log(`[ByPage] folder "${fid}" skipped — single source`);
    return 0;
  }

  const ordered = [...groups.values()].sort((a, b) => b.items.length - a.items.length);
  const stamp = Date.now().toString(36);
  const restore = {};
  const tempIds = [];

  ordered.forEach((g) => {
    const id = `pgtemp_${stamp}_${++tempSeq}`;
    tempIds.push(id);
    let label = g.label;
    if (label.length > 30) label = label.slice(0, 30) + '…';
    state.folders.push({ id, name: `${tempIds.length}. ${label}`, parent: fid, temp: true });
    g.items.forEach((it) => {
      restore[it.url] = it.folder;
      it.folder = id;
    });
  });

  pageGroup.byFolder[fid] = { restore, tempIds };
  console.log(`[ByPage] folder "${fid}" → created ${ordered.length} folders`);
  return ordered.length;
}

/* group this folder's items AND all subfolders' items into temp page folders
   placed inside this folder, so you see the whole tree at once */
async function groupSubFolders(fid) {
  const treeIds = new Set(getFolderTreeIds(fid));
  const scope = state.items.filter((i) =>
    treeIds.has(i.folder) && i.folder !== 'removed' && !String(i.folder).startsWith('pgtemp_')
  );
  console.log(`[ByPage] SUB "${fid}" → ${scope.length} items across ${treeIds.size} folders`);
  if (!scope.length) return 0;

  const groups = buildGroups(scope);
  const summary = [...groups.values()].map((x) => `${x.label} (${x.items.length})`).join(', ');
  console.log(`[ByPage] SUB "${fid}" → ${groups.size} source(s): ${summary}`);

  if (groups.size < 2) {
    console.log(`[ByPage] SUB "${fid}" skipped — single source`);
    return 0;
  }

  const ordered = [...groups.values()].sort((a, b) => b.items.length - a.items.length);
  const stamp = Date.now().toString(36);
  const restore = {};
  const tempIds = [];

  ordered.forEach((g) => {
    const id = `pgtemp_${stamp}_${++tempSeq}`;
    tempIds.push(id);
    let label = g.label;
    if (label.length > 30) label = label.slice(0, 30) + '…';
    state.folders.push({ id, name: `${tempIds.length}. ${label}`, parent: fid, temp: true });
    g.items.forEach((it) => {
      restore[it.url] = it.folder;   /* remember original folder */
      it.folder = id;                 /* temp-move into the page folder */
    });
  });

  pageGroup.byFolder['__sub__' + fid] = { restore, tempIds };
  console.log(`[ByPage] SUB "${fid}" → created ${ordered.length} page folders`);
  return ordered.length;
}

/* generic: restore items grouped under `key` and delete its temp folders */
function ungroupByKey(key) {
  const g = pageGroup.byFolder[key];
  if (!g) return 0;
  const restore = g.restore;
  let count = 0;
  state.items.forEach((i) => {
    if (!Object.prototype.hasOwnProperty.call(restore, i.url)) return;
    count++;
    const target = restore[i.url];
    const exists = target && (target === 'root' || target === 'removed' || getFolder(target));
    i.folder = exists ? target : 'root';
  });
  const tempSet = new Set(g.tempIds);
  state.folders = state.folders.filter((f) => !tempSet.has(f.id));
  delete pageGroup.byFolder[key];
  return count;
}

/* restore ONE folder's grouping; returns number of items returned */
function ungroupOneFolder(fid) {
  return ungroupByKey(fid);
}

/* restore a sub-folder grouping */
function ungroupSubFolders(fid) {
  return ungroupByKey('__sub__' + fid);
}

/* silently resolve a folder's grouping (used before deleting a grouped folder) */
async function clearGroupingFor(folderId) {
  let changed = false;
  if (pageGroup.byFolder[folderId]) { ungroupOneFolder(folderId); changed = true; }
  if (pageGroup.byFolder['__sub__' + folderId]) { ungroupSubFolders(folderId); changed = true; }
  if (changed) await persistPageGroup();
}

/* ---- 🗂 This Folder ---- */

async function enablePageGrouping() {
  const fid = state.folderId;
  if (fid === 'removed') { showToast("Can't group the Trash", null); return; }
  if (pageGroup.byFolder['__sub__' + fid]) ungroupSubFolders(fid);   /* exclusive */

  const n = await groupOneFolder(fid);
  if (!n) {
    showToast('Nothing to group — everything here is from one source', null);
    return;
  }
  await persistPageGroup();
  await saveData();
  state.page = 1;
  state.selected.clear();
  render();
  showToast(`Grouped "${(getFolder(fid) || {}).name || 'folder'}" into ${n} folders`, null);
}

async function disablePageGrouping() {
  const fid = state.folderId;
  const count = ungroupOneFolder(fid);
  if (!count) return;
  await persistPageGroup();
  await saveData();
  state.page = 1;
  render();
  showToast(`Returned ${count} items to "${(getFolder(fid) || {}).name || 'folder'}"`, null);
}

/* ---- 🗂 Sub Folders ---- */

async function enablePageGroupingSub() {
  const fid = state.folderId;
  if (fid === 'removed') { showToast("Can't group the Trash", null); return; }
  if (pageGroup.byFolder[fid]) ungroupOneFolder(fid);   /* exclusive with This Folder */

  const n = await groupSubFolders(fid);
  if (!n) {
    showToast('Nothing to group — everything in this folder tree is from one source', null);
    return;
  }
  await persistPageGroup();
  await saveData();
  state.page = 1;
  state.selected.clear();
  render();
  showToast(`Grouped "${(getFolder(fid) || {}).name || 'folder'}" + subfolders into ${n} page folders`, null);
}

async function disablePageGroupingSub() {
  const fid = state.folderId;
  const count = ungroupSubFolders(fid);
  if (!count) return;
  await persistPageGroup();
  await saveData();
  state.page = 1;
  render();
  showToast(`Returned ${count} items to their folders`, null);
}

/* ---- 🗂 All Folders ---- */

/* gather ALL items (from every folder) into temporary page folders at the
   root, so you can see the whole library at once, grouped by source site */
async function groupAllToRoot() {
  const scope = state.items.filter((i) => i.folder !== 'removed' && !String(i.folder).startsWith('pgtemp_'));
  console.log(`[ByPage] ALL → gathering ${scope.length} items from all folders`);
  if (!scope.length) return 0;

  const groups = buildGroups(scope);
  const summary = [...groups.values()].map((x) => `${x.label} (${x.items.length})`).join(', ');
  console.log(`[ByPage] ALL → ${groups.size} source(s): ${summary}`);

  if (groups.size < 2) {
    console.log(`[ByPage] ALL skipped — single source`);
    return 0;
  }

  const ordered = [...groups.values()].sort((a, b) => b.items.length - a.items.length);
  const stamp = Date.now().toString(36);
  const restore = {};
  const tempIds = [];

  ordered.forEach((g) => {
    const id = `pgtemp_${stamp}_${++tempSeq}`;
    tempIds.push(id);
    let label = g.label;
    if (label.length > 30) label = label.slice(0, 30) + '…';
    state.folders.push({ id, name: `${tempIds.length}. ${label}`, parent: 'root', temp: true });
    g.items.forEach((it) => {
      restore[it.url] = it.folder;
      it.folder = id;
    });
  });

  pageGroup.byFolder['__all__'] = { restore, tempIds };
  console.log(`[ByPage] ALL → created ${ordered.length} page folders at root`);
  return ordered.length;
}

async function enablePageGroupingAll() {
  const n = await groupAllToRoot();
  if (!n) {
    showToast('Nothing to group — everything is from one source', null);
    return;
  }
  await persistPageGroup();
  await saveData();
  state.folderId = 'root';   /* jump to All so you see everything at once */
  state.page = 1;
  state.selected.clear();
  render();
  showToast(`Everything grouped into ${n} page folders in All`, null);
}

async function disablePageGroupingAll() {
  const count = ungroupByKey('__all__');
  if (!count) return;
  await persistPageGroup();
  await saveData();
  state.folderId = 'root';
  state.page = 1;
  render();
  showToast(`Ungrouped — ${count} items back in their folders`, null);
}

/* ---------------- GIF verification (magic bytes) ---------------- */

async function sniffGif(url) {
  try {
    const res = await fetch(url);
    if (!res.ok && res.status !== 206) return null;
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) return null;
    const { value } = await reader.read();
    try { await reader.cancel(); } catch {}
    const b = value;
    return !!b && b.length > 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38;
  } catch {
    return null;
  }
}

async function verifyItemGif(item) {
  if (!item.directImage || item.gifChecked || !looksLikeGif(item)) return false;
  const result = await sniffGif(item.directImage);
  if (result === null) return false;
  item.isGif = result;
  item.gifChecked = true;
  return true;
}

function refreshGifBadges() {
  state.pageItems.forEach((item) => {
    const card = document.querySelector(`.grid-item[data-url="${CSS.escape(item.url)}"]`);
    if (!card) return;
    const existing = card.querySelector('.gif-badge');
    const gif = isGifItem(item);
    if (gif && !existing) {
      const b = document.createElement('span');
      b.className = 'gif-badge';
      b.textContent = 'GIF';
      card.appendChild(b);
    } else if (!gif && existing) {
      existing.remove();
    }
  });
}

function queueGifVerification() {
  if (verifyQueueBusy || verifyRunning) return;
  const pending = state.pageItems.filter((i) => i.directImage && !i.gifChecked && looksLikeGif(i));
  if (!pending.length) return;

  verifyQueueBusy = true;
  (async () => {
    let changed = false;
    for (const item of pending.slice(0, 12)) {
      if (await verifyItemGif(item)) changed = true;
      await sleep(60);
    }
    if (changed) {
      await saveData();
      refreshGifBadges();
      if (state.gifOnly) render();
    }
    verifyQueueBusy = false;
  })();
}

async function verifyAllGifs() {
  if (verifyRunning) return;

  const targets = state.items.filter((i) => i.directImage && !i.gifChecked && looksLikeGif(i));
  if (!targets.length) {
    showToast('All .gif items are already verified', null);
    return;
  }

  verifyRunning = true;
  const btn = $('verifyGifsBtn');
  if (btn) { btn.classList.add('busy'); btn.textContent = '🎞 Sniffing…'; }

  const progressInfo = $('progressInfo');
  const progressFill = $('progressFill');
  const progressText = $('progressText');
  if (progressInfo) progressInfo.classList.add('show');

  let real = 0, fake = 0;

  for (let i = 0; i < targets.length; i++) {
    if (progressText) progressText.textContent = `Sniffing file ${i + 1} of ${targets.length}…`;
    if (progressFill) progressFill.style.width = `${((i + 1) / targets.length) * 92}%`;

    if (await verifyItemGif(targets[i])) {
      if (targets[i].isGif) real++;
      else fake++;
    }
    if (i % 10 === 9) await saveData();
    await sleep(40);
  }

  await saveData();
  if (progressInfo) progressInfo.classList.remove('show');

  verifyRunning = false;
  if (btn) { btn.classList.remove('busy'); btn.textContent = '🎞 Verify GIFs'; }

  render();
  showToast(`Verified: ${real} real GIF${real !== 1 ? 's' : ''}, ${fake} fake${fake !== 1 ? 's' : ''} unflagged`, null);
}

/* ---------------- duplicate detection (perceptual hash) ---------------- */

async function computeDHash(url) {
  let objUrl = null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size < 8) return null;
    objUrl = URL.createObjectURL(blob);

    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('image failed to load'));
      im.src = objUrl;
    });

    const c = document.createElement('canvas');
    c.width = 9;
    c.height = 8;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 9, 8);
    const d = ctx.getImageData(0, 0, 9, 8).data;

    let hash = 0n;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const a = (y * 9 + x) * 4;
        const b = a + 4;
        const la = d[a] + d[a + 1] + d[a + 2];
        const lb = d[b] + d[b + 1] + d[b + 2];
        hash = (hash << 1n) | (la > lb ? 1n : 0n);
      }
    }
    return hash.toString(16);
  } catch {
    return null;
  } finally {
    if (objUrl) URL.revokeObjectURL(objUrl);
  }
}

function hamming(a, b) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let c = 0;
  while (x) { c += Number(x & 1n); x >>= 1n; }
  return c;
}

function pickKeeper(group) {
  return group.slice().sort((a, b) => {
    if (!!a.fav !== !!b.fav) return a.fav ? -1 : 1;
    if (!!a.directImage !== !!b.directImage) return a.directImage ? -1 : 1;
    return (a.addedAt || 0) - (b.addedAt || 0);
  })[0];
}

async function findDuplicates() {
  const scope = state.items.filter((i) => i.folder !== 'removed' && i.directImage);
  if (!scope.length) {
    alert('Nothing to scan.');
    return;
  }

  const needHash = scope.filter((i) => !i.phash);
  if (needHash.length > 120 &&
      !confirm(`Fingerprint ${needHash.length} images?\n\nFirst run downloads each image once (later runs are instant).`)) {
    return;
  }

  const btn = $('dupesBtn');
  if (btn) { btn.classList.add('busy'); btn.textContent = '👥 Scanning…'; }

  const progressInfo = $('progressInfo');
  const progressFill = $('progressFill');
  const progressText = $('progressText');
  if (progressInfo) progressInfo.classList.add('show');

  for (let i = 0; i < scope.length; i++) {
    const it = scope[i];
    if (progressText) progressText.textContent = `Fingerprinting ${i + 1} of ${scope.length}…`;
    if (progressFill) progressFill.style.width = `${((i + 1) / scope.length) * 88}%`;

    if (!it.phash) {
      const h = await computeDHash(it.directImage);
      if (h) it.phash = h;
      if (i % 10 === 9) await saveData();
      await sleep(30);
    }
  }
  await saveData();

  const similar = (a, b) =>
    a.directImage === b.directImage ||
    (a.phash && b.phash && hamming(a.phash, b.phash) <= 8);

  const clusters = [];
  const used = new Set();
  for (const it of scope) {
    if (used.has(it.url)) continue;
    const group = [it];
    used.add(it.url);
    for (const other of scope) {
      if (used.has(other.url)) continue;
      if (similar(it, other)) {
        group.push(other);
        used.add(other.url);
      }
    }
    if (group.length > 1) clusters.push(group);
  }

  if (progressInfo) progressInfo.classList.remove('show');
  if (btn) { btn.classList.remove('busy'); btn.textContent = '👥 Dupes'; }

  dupeClusters = clusters;
  renderDupesModal(clusters);
}

function renderDupesModal(clusters) {
  const body = $('dupesBody');
  const modal = $('dupesModal');
  const mergeAll = $('mergeAllDupes');
  if (!body || !modal) return;

  if (!clusters.length) {
    body.innerHTML = '<div class="dupes-empty">✅ No duplicates found — your library is clean.</div>';
    if (mergeAll) mergeAll.style.display = 'none';
    modal.classList.add('show');
    return;
  }

  if (mergeAll) mergeAll.style.display = '';

  body.innerHTML = clusters.map((group, gi) => {
    const keeper = pickKeeper(group);
    const thumbs = group.map((it) =>
      `<img src="${esc(getThumb(it))}" class="${it.url === keeper.url ? 'dupe-keep' : ''}" title="${esc(it.url)}">`
    ).join('');
    return `
      <div class="dupe-group" data-g="${gi}">
        <div class="dupe-thumbs">${thumbs}</div>
        <div class="dupe-meta"><b>${group.length} copies</b><span>keeper outlined</span></div>
        <button class="dupe-merge primary" data-g="${gi}">Merge</button>
      </div>
    `;
  }).join('');

  body.querySelectorAll('.dupe-merge').forEach((mbtn) => {
    mbtn.addEventListener('click', async () => {
      const g = dupeClusters[Number(mbtn.dataset.g)];
      if (g) await mergeDupeGroup(g, false);
      mbtn.closest('.dupe-group').remove();
      dupeClusters = dupeClusters.filter((c) => c !== g);
      if (!body.querySelectorAll('.dupe-group').length) {
        body.innerHTML = '<div class="dupes-empty">✅ All duplicates merged.</div>';
        if (mergeAll) mergeAll.style.display = 'none';
      }
    });
  });

  modal.classList.add('show');
}

async function mergeDupeGroup(group, quiet) {
  const keeper = pickKeeper(group);
  const losers = group.filter((i) => i.url !== keeper.url).map((i) => i.url);
  if (!losers.length) return 0;

  if (quiet) {
    const set = new Set(losers);
    state.items.forEach((i) => { if (set.has(i.url)) i.folder = 'removed'; });
    return losers.length;
  }
  await removeItems(losers, false, false);
  return losers.length;
}

/* ---------------- selection (in-place, no re-render) ---------------- */

function updateStats() {
  const c = state.viewCounts;
  setText('stats', `${c.folders} folders, ${c.items} images${state.selected.size ? ` (${state.selected.size} selected)` : ''}`);
}

function syncSelectionUI() {
  document.querySelectorAll('.grid-item[data-url]').forEach((card) => {
    const sel = state.selected.has(card.dataset.url);
    card.classList.toggle('selected', sel);
    const cb = card.querySelector('.select-checkbox');
    if (cb) cb.checked = sel;
  });
  updateStats();
  renderBulkControls();
}

function updateStorageMeter() {
  try {
    chrome.storage.local.getBytesInUse(null, (bytes) => {
      if (chrome.runtime.lastError) return;
      const label = bytes > 1048576
        ? `${(bytes / 1048576).toFixed(1)} MB`
        : `${Math.max(1, Math.round(bytes / 1024))} KB`;
      setText('storageChip', `💽 ${label}`);
    });
  } catch {}
}

/* ---------------- lightbox + magnifier + slideshow ---------------- */

function isLightboxOpen() {
  const lb = $('lightbox');
  return !!lb && lb.classList.contains('show');
}

function fitLightboxImage() {
  const img = $('lbImage');
  if (!img) return;
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!nw || !nh) { img.style.width = ''; img.style.height = ''; return; }

  const maxW = window.innerWidth * 0.92;
  const maxH = window.innerHeight * 0.74;
  const scale = Math.min(maxW / nw, maxH / nh, 4);

  if (scale > 1) {
    img.style.width = `${Math.round(nw * scale)}px`;
    img.style.height = 'auto';
  } else {
    img.style.width = '';
    img.style.height = '';
  }
}

function updateLbStar() {
  const item = state.pageItems[lightboxState.index];
  const btn = $('lbStar');
  if (!item || !btn) return;
  btn.textContent = item.fav ? '⭐' : '☆';
  btn.classList.toggle('active', !!item.fav);
}

function showLightboxAt(idx) {
  const items = state.pageItems;
  const lb = $('lightbox');
  if (!lb || !items.length) return;

  lightboxState.index = ((idx % items.length) + items.length) % items.length;
  const item = items[lightboxState.index];

  const loupe = $('lbLoupe');
  if (loupe) loupe.classList.remove('show');

  const img = $('lbImage');
  img.style.width = '';
  img.style.height = '';
  img.src = item.directImage || NO_IMAGE;
  img.alt = item.url;
  img.style.animation = 'none';
  void img.offsetWidth;
  img.style.animation = '';

  setText('lbCounter', `${String(lightboxState.index + 1).padStart(2, '0')} / ${String(items.length).padStart(2, '0')}`);
  setText('lbUrl', item.url);
  updateLbStar();

  const gifTag = $('lbGifTag');
  if (gifTag) gifTag.style.display = isGifItem(item) ? '' : 'none';

  $('lbOpenImg').onclick = () => window.open(item.directImage || item.url, '_blank');
  $('lbOpenPage').onclick = () => window.open(item.url, '_blank');
  $('lbCopy').onclick = async () => {
    await navigator.clipboard.writeText(item.url);
    const b = $('lbCopy');
    b.textContent = '✓ Copied';
    setTimeout(() => (b.textContent = 'Copy URL'), 1000);
  };

  lb.classList.add('show');
}

function openLightbox(item) {
  const idx = state.pageItems.findIndex((i) => i.url === item.url);
  if (idx < 0) return;
  showLightboxAt(idx);
}

function stopSlideshow() {
  if (slideshowTimer) {
    clearInterval(slideshowTimer);
    slideshowTimer = null;
  }
  const btn = $('lbSlideshow');
  if (btn) {
    btn.textContent = '▶ Slideshow';
    btn.classList.remove('active');
  }
}

function closeLightbox() {
  const lb = $('lightbox');
  if (lb) lb.classList.remove('show');
  const loupe = $('lbLoupe');
  if (loupe) loupe.classList.remove('show');
  stopSlideshow();
  lightboxState.index = -1;
}

function lbStep(delta) {
  if (lightboxState.index < 0) return;
  showLightboxAt(lightboxState.index + delta);
}

function toggleSlideshow() {
  const btn = $('lbSlideshow');
  if (!btn) return;
  if (slideshowTimer) {
    stopSlideshow();
    return;
  }
  btn.textContent = '⏸ Pause';
  btn.classList.add('active');
  slideshowTimer = setInterval(() => lbStep(1), 3000);
}

async function lbSave() {
  const item = state.pageItems[lightboxState.index];
  const btn = $('lbSave');
  if (!item || !item.directImage) {
    alert('No direct image to save for this item.');
    return;
  }
  btn.textContent = '⏳ Saving…';
  try {
    const res = await fetch(item.directImage);
    if (!res.ok) throw new Error('bad response');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = safeFilename(getBaseNameFromUrl(item.directImage, 0));
    a.click();
    URL.revokeObjectURL(a.href);
    btn.textContent = '✓ Saved';
  } catch {
    btn.textContent = '✕ Blocked';
  }
  setTimeout(() => (btn.textContent = '⬇ Save'), 1300);
}

function toggleMagnify() {
  magState.enabled = !magState.enabled;
  const btn = $('lbMagnify');
  if (btn) btn.classList.toggle('active', magState.enabled);
  const img = $('lbImage');
  if (img) img.classList.toggle('magnifying', magState.enabled);
  if (!magState.enabled) {
    const loupe = $('lbLoupe');
    if (loupe) loupe.classList.remove('show');
  }
}

function updateLoupe(e) {
  const img = $('lbImage');
  const loupe = $('lbLoupe');
  if (!img || !loupe || !magState.enabled) return;

  const rect = img.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
    loupe.classList.remove('show');
    return;
  }

  const radius = loupe.offsetWidth / 2;
  const z = magState.zoom;

  loupe.style.backgroundImage = `url("${img.src}")`;
  loupe.style.backgroundSize = `${rect.width * z}px ${rect.height * z}px`;
  loupe.style.backgroundPosition = `${-(x * z - radius)}px ${-(y * z - radius)}px`;
  loupe.style.left = `${e.clientX}px`;
  loupe.style.top = `${e.clientY}px`;
  loupe.classList.add('show');
  setText('lbLoupeZoom', `${z.toFixed(1)}×`);
}

/* ---------------- rendering ---------------- */

function hideAllMenus() {
  document.querySelectorAll('.item-menu-dropdown').forEach((m) => m.classList.remove('show'));
}

function updateBreadcrumbs() {
  const bc = $('breadcrumbs');
  if (!bc) return;
  bc.innerHTML = '';

  const rootCrumb = document.createElement('span');
  rootCrumb.className = `crumb${state.folderId === 'root' ? ' active' : ''}`;
  rootCrumb.textContent = '📁 All';
  rootCrumb.onclick = () => {
    if (state.folderId !== 'root') {
      state.folderId = 'root';
      state.page = 1;
      state.selected.clear();
      render();
    }
  };
  bc.appendChild(rootCrumb);

  if (state.folderId === 'root') return;

  const path = [];
  let current = getFolder(state.folderId);
  while (current && current.id !== 'root') {
    path.unshift(current);
    current = current.parent ? getFolder(current.parent) : null;
  }

  const sep = document.createElement('span');
  sep.className = 'separator';
  sep.textContent = '>';
  bc.appendChild(sep);

  path.forEach((folder, index) => {
    const span = document.createElement('span');
    span.className = `crumb${index === path.length - 1 ? ' active' : ''}`;
    span.textContent = folder.name;
    if (index < path.length - 1) {
      span.onclick = () => {
        state.folderId = folder.id;
        state.page = 1;
        state.selected.clear();
        render();
      };
    }
    bc.appendChild(span);

    if (index < path.length - 1) {
      const sep2 = document.createElement('span');
      sep2.className = 'separator';
      sep2.textContent = '>';
      bc.appendChild(sep2);
    }
  });
}

function applyDisplaySettings() {
  const grid = $('grid');
  if (!grid) return;
  grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${state.display.gridSize}px, 1fr))`;
  grid.style.gap = `${state.display.gap}px`;
  grid.style.setProperty('--img-h', `${state.display.imageHeight}px`);
  document.querySelectorAll('.grid-item-image').forEach((img) => {
    img.style.height = `${state.display.imageHeight}px`;
  });
  document.querySelectorAll('.grid-item-url').forEach((urlDiv) => {
    urlDiv.style.display = state.display.showUrls ? 'block' : 'none';
  });
}

function render() {
  const grid = $('grid');
  if (!grid) return;

  console.log('[grid.js] render:', { folderId: state.folderId, itemsCount: state.items.length, pageItems: state.pageItems.length });
  if (state.folderId !== 'root' && state.folderId !== 'removed' && !getFolder(state.folderId)) {
    state.folderId = 'root';
  }

  grid.innerHTML = '';

  grid.ondragover = (e) => {
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch {}
  };

  grid.ondrop = (e) => {
    e.preventDefault();
    if (!state.dragged) return;
    if (state.dragged.type === 'folder') moveFolder(state.dragged.id, 'root');
    if (state.dragged.type === 'item') moveItems(getTargetUrls(state.dragged.id), 'root');
  };

  updateBreadcrumbs();

  let subFolders = state.folders.filter((f) => f.parent === state.folderId && !f.hidden);
  let items = state.items.filter((i) => i.folder === state.folderId);

  if (state.favOnly) items = items.filter((i) => i.fav);
  if (state.gifOnly) items = items.filter(isGifItem);

  if (state.search) {
    const q = state.search.toLowerCase();
    items = items.filter((i) => (i.url || '').toLowerCase().includes(q));
    subFolders = subFolders.filter((f) => (f.name || '').toLowerCase().includes(q));
  }

  items = items.slice();
  if (state.sort === 'newest') {
    items.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  } else {
    items.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  }

  const totalPages = Math.ceil(items.length / state.perPage) || 1;
  if (state.page > totalPages) state.page = totalPages;

  const start = (state.page - 1) * state.perPage;
  state.pageItems = items.slice(start, start + state.perPage);
  state.viewCounts = { folders: subFolders.length, items: items.length };

  saveViewState();
  updateStorageMeter();
  updatePageGroupChip();

  setText('pageInfo', `Page ${state.page} of ${totalPages}`);
  updateStats();
  setText('trashCount', String(state.items.filter((i) => i.folder === 'removed').length));

  const prevBtn = $('prevPage');
  const nextBtn = $('nextPage');
  if (prevBtn) prevBtn.disabled = state.page <= 1;
  if (nextBtn) nextBtn.disabled = state.page >= totalPages;

  subFolders.forEach((folder) => grid.appendChild(createFolderCard(folder)));

  if (!state.pageItems.length && !subFolders.length) {
    grid.innerHTML =
      '<div style="grid-column:1/-1;text-align:center;padding:40px;color:#666;">Nothing found here.</div>';
    renderBulkControls();
    applyDisplaySettings();
    queueGifVerification();
    return;
  }

  state.pageItems.forEach((item) => grid.appendChild(createImageCard(item)));

  renderBulkControls();
  applyDisplaySettings();
  queueGifVerification();
}

function createFolderCard(folder) {
  const div = document.createElement('div');
  div.className = 'grid-item grid-folder';
  div.draggable = true;
  div.dataset.folderId = folder.id;

  div.innerHTML = `
    <div class="folder-icon">${folder.temp ? '🗂' : '📁'}</div>
    <div class="folder-name">${esc(folder.name)}</div>
    <div class="folder-count">${getItemCount(folder.id)} items</div>
    <div class="item-menu">
      <button class="item-menu-btn">⋮</button>
      <div class="item-menu-dropdown">
        <button class="rename-folder-btn">✏️ Rename</button>
        <button class="move-folder-btn">📤 Move</button>
        <button class="delete-folder-btn danger">🗑️ Delete</button>
      </div>
    </div>
  `;

  div.addEventListener('click', (e) => {
    if (e.target.closest('.item-menu')) return;
    state.folderId = folder.id;
    state.page = 1;
    state.selected.clear();
    render();
  });

  const menuBtn = div.querySelector('.item-menu-btn');
  const dropdown = div.querySelector('.item-menu-dropdown');

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hideAllMenus();
    dropdown.classList.toggle('show');
  });

  div.querySelector('.rename-folder-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const newName = prompt('Rename folder:', folder.name);
    if (!newName || !newName.trim()) return;
    folder.name = newName.trim();
    await saveData();
    render();
  });

  div.querySelector('.delete-folder-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${folder.name}"? Items inside will be moved to the parent folder.`)) return;
    await clearGroupingFor(folder.id);
    state.folders.filter((f) => f.parent === folder.id).forEach((f) => (f.parent = folder.parent));
    state.items.filter((i) => i.folder === folder.id).forEach((i) => (i.folder = folder.parent));
    state.folders = state.folders.filter((f) => f.id !== folder.id);
    await saveData();
    render();
  });

  div.querySelector('.move-folder-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    showMoveFolderModal(folder.id);
  });

  div.addEventListener('dragstart', (e) => {
    state.dragged = { type: 'folder', id: folder.id };
    try {
      e.dataTransfer.setData('text/folder', folder.id);
      e.dataTransfer.effectAllowed = 'move';
    } catch {}
    div.classList.add('dragging');
  });

  div.addEventListener('dragend', () => {
    div.classList.remove('dragging');
    state.dragged = null;
  });

  div.addEventListener('dragover', (e) => {
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch {}
    if (
      state.dragged &&
      state.dragged.type === 'folder' &&
      state.dragged.id !== folder.id &&
      !isDescendant(state.dragged.id, folder.id)
    ) {
      div.classList.add('drag-over');
    }
  });

  div.addEventListener('dragleave', () => div.classList.remove('drag-over'));

  div.addEventListener('drop', (e) => {
    e.preventDefault();
    div.classList.remove('drag-over');
    if (!state.dragged) return;
    if (state.dragged.type === 'item') moveItems(getTargetUrls(state.dragged.id), folder.id);
    if (
      state.dragged.type === 'folder' &&
      state.dragged.id !== folder.id &&
      !isDescendant(state.dragged.id, folder.id)
    ) {
      moveFolder(state.dragged.id, folder.id);
    }
  });

  return div;
}

function createImageCard(item) {
  const div = document.createElement('div');
  const selected = state.selected.has(item.url);

  div.className = `grid-item${selected ? ' selected' : ''}${item.fav ? ' fav' : ''}`;
  div.draggable = true;
  div.dataset.url = item.url;

  const gif = isGifItem(item);
  const imgSrc = gif ? (item.directImage || getThumb(item)) : getThumb(item);

  div.innerHTML = `
    <div class="item-select">
      <input type="checkbox" class="select-checkbox" ${selected ? 'checked' : ''}>
    </div>
    <button class="fav-chip${item.fav ? ' on' : ''}" title="Favorite">${item.fav ? '⭐' : '☆'}</button>
    <img class="grid-item-image" src="${esc(imgSrc)}" loading="lazy">
    ${gif ? '<span class="gif-badge">GIF</span>' : ''}
    <div class="grid-item-info">
      <div class="grid-item-url">${esc(item.url)}</div>
      <div class="grid-item-actions">
        <button class="open-img-btn">Open Image</button>
        <button class="open-page-btn">Open Page</button>
      </div>
    </div>
    <div class="item-menu">
      <button class="item-menu-btn">⋮</button>
      <div class="item-menu-dropdown">
        <button class="move-item-btn">📁 Move to...</button>
        <button class="query-move-btn">🔎 To query folder</button>
        <button class="remove-item-btn danger">🗑️ Remove</button>
      </div>
    </div>
  `;

  const checkbox = div.querySelector('.select-checkbox');
  checkbox.addEventListener('click', (e) => {
    e.stopPropagation();
    const pageUrls = state.pageItems.map((i) => i.url);
    const idx = pageUrls.indexOf(item.url);

    if (e.shiftKey && state.lastIndex !== null && idx >= 0) {
      const start = Math.min(state.lastIndex, idx);
      const end = Math.max(state.lastIndex, idx);
      for (let i = start; i <= end; i++) state.selected.add(pageUrls[i]);
    } else if (checkbox.checked) {
      state.selected.add(item.url);
    } else {
      state.selected.delete(item.url);
    }

    if (idx >= 0) state.lastIndex = idx;
    syncSelectionUI();
  });

  const favBtn = div.querySelector('.fav-chip');
  favBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    item.fav = !item.fav;
    favBtn.textContent = item.fav ? '⭐' : '☆';
    favBtn.classList.toggle('on', !!item.fav);
    div.classList.toggle('fav', !!item.fav);
    await saveData();
    if (state.favOnly && !item.fav) render();
  });

  div.addEventListener('click', (e) => {
    if (
      e.target.closest('.item-menu') ||
      e.target.closest('.grid-item-actions') ||
      e.target.closest('.item-select') ||
      e.target.closest('.fav-chip')
    ) {
      return;
    }
    openLightbox(item);
  });

  div.querySelector('.open-img-btn').addEventListener('click', () => {
    window.open(item.directImage || imgSrc, '_blank');
  });
  div.querySelector('.open-page-btn').addEventListener('click', () => window.open(item.url, '_blank'));

  const menuBtn = div.querySelector('.item-menu-btn');
  const dropdown = div.querySelector('.item-menu-dropdown');

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hideAllMenus();
    dropdown.classList.toggle('show');
  });

  div.querySelector('.move-item-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    showMoveToModal(getTargetUrls(item.url));
  });

  div.querySelector('.query-move-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    hideAllMenus();
    moveToQueryFolder(getTargetUrls(item.url));
  });

  const isTrash = state.folderId === 'removed';
  const removeBtn = div.querySelector('.remove-item-btn');
  if (isTrash) removeBtn.textContent = '🗑️ Delete';

  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeItems(getTargetUrls(item.url), isTrash, false);
  });

  div.addEventListener('dragstart', (e) => {
    state.dragged = { type: 'item', id: item.url };
    try {
      e.dataTransfer.setData('text/item', item.url);
      e.dataTransfer.effectAllowed = 'move';
    } catch {}
    div.classList.add('dragging');
    if (!state.selected.has(item.url)) {
      state.selected.clear();
      state.selected.add(item.url);
      syncSelectionUI();
    }
  });

  div.addEventListener('dragend', () => {
    div.classList.remove('dragging');
    state.dragged = null;
  });

  return div;
}

/* ---------------- modals ---------------- */

function showMoveFolderModal(folderId) {
  const modal = $('moveToModal');
  const list = $('moveToFolderList');
  if (!modal || !list) return;

  const movingFolder = getFolder(folderId);
  if (!movingFolder) return;

  list.innerHTML = '';

  const rootBtn = document.createElement('button');
  rootBtn.textContent = '📁 All (root)';
  rootBtn.onclick = async () => {
    modal.classList.remove('show');
    await moveFolder(folderId, 'root');
  };
  list.appendChild(rootBtn);

  const options = state.folders
    .filter((f) => f.id !== folderId && f.id !== 'root' && !f.hidden && !isDescendant(folderId, f.id))
    .map((f) => ({ id: f.id, path: getFolderPath(f.id) }))
    .sort((a, b) => a.path.localeCompare(b.path));

  options.forEach((opt) => {
    const btn = document.createElement('button');
    btn.textContent = `📁 ${opt.path}`;
    btn.onclick = async () => {
      modal.classList.remove('show');
      await moveFolder(folderId, opt.id);
    };
    list.appendChild(btn);
  });

  modal.classList.add('show');
}

function showMoveToModal(urls) {
  const modal = $('moveToModal');
  const list = $('moveToFolderList');
  if (!modal || !list) return;

  list.innerHTML = '';

  const firstItem = state.items.find((i) => i.url === urls[0]);
  const itemInTrash = firstItem ? isInTrash(firstItem.folder) : false;

  const options = state.folders
    .map((f) => ({ ...f, path: getFolderPath(f.id) }))
    .filter((f) => {
      const trashOrSub = f.id === 'removed' || isInTrash(f.id);
      return itemInTrash ? trashOrSub : !f.hidden;
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  options.forEach((folder) => {
    const btn = document.createElement('button');
    btn.textContent = `📁 ${folder.path}`;
    btn.onclick = () => {
      modal.classList.remove('show');
      moveItems(urls, folder.id);
    };
    list.appendChild(btn);
  });

  modal.classList.add('show');
}

async function showStats() {
  const total = state.items.length;
  const inTrash = state.items.filter((i) => i.folder === 'removed').length;
  const favs = state.items.filter((i) => i.fav).length;
  const gifs = state.items.filter(isGifItem).length;
  const withImg = state.items.filter((i) => i.directImage).length;
  const folderCount = state.folders.filter((f) => !f.hidden && f.id !== 'root').length;
  const rootN = getItemCount('root');

  const times = state.items.map((i) => i.addedAt).filter(Boolean);
  const oldest = times.length ? new Date(Math.min(...times)).toLocaleDateString() : '—';
  const newest = times.length ? new Date(Math.max(...times)).toLocaleDateString() : '—';

  const domainCount = {};
  state.items.forEach((i) => {
    if (!i.directImage) return;
    try {
      const h = new URL(i.directImage).hostname;
      domainCount[h] = (domainCount[h] || 0) + 1;
    } catch {}
  });
  const topDomains = Object.entries(domainCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const perFolder = state.folders
    .filter((f) => !f.hidden && f.id !== 'root')
    .map((f) => ({ name: f.name, n: getItemCount(f.id) }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 6);

  chrome.storage.local.getBytesInUse(null, (bytes) => {
    const size = bytes > 1048576
      ? `${(bytes / 1048576).toFixed(2)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

    const rows = [
      ['Images collected', total],
      ['With direct image', withImg],
      ['Favorites', favs],
      ['GIFs (verified + guessed)', gifs],
      ['In trash', inTrash],
      ['Folders', folderCount],
      ['In root (All)', rootN],
      ['Oldest item', oldest],
      ['Newest item', newest],
      ['Storage used', size]
    ]
      .map(([k, v]) => `<div class="stat-row"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`)
      .join('');

    const domHtml = topDomains.length
      ? `<div class="stat-sub">Top image hosts</div>` +
        topDomains.map(([d, n]) => `<div class="stat-row"><span>${esc(d)}</span><b class="amber">${n}</b></div>`).join('')
      : '';

    const foldHtml = perFolder.length
      ? `<div class="stat-sub">Biggest folders</div>` +
        perFolder.map((f) => `<div class="stat-row"><span>${esc(f.name)}</span><b class="amber">${f.n}</b></div>`).join('')
      : '';

    $('statsBody').innerHTML = rows + domHtml + foldHtml;
    $('statsModal').classList.add('show');
  });
}

/* ---------------- bulk controls ---------------- */

function renderBulkControls() {
  const controls = $('bulkControls');
  if (!controls) return;

  if (!state.selected.size) {
    controls.classList.remove('show');
    return;
  }

  controls.classList.add('show');

  controls.innerHTML = `
    <span class="bulk-label">${state.selected.size} selected</span>
    <button id="copySelected" class="primary">📋 Copy URLs</button>
    <button id="copyMD">Copy MD</button>
    <button id="openSelected">🔗 Open</button>
    <button id="selectAllPage">Select All Visible</button>
    <button id="deselectAll">Deselect All</button>
    <button id="bulkMove" class="primary">📁 Move to...</button>
    <button id="bulkQueryMove">🔎 Auto-Sort by Query</button>
    <button id="bulkRemove" class="danger">🗑️ Remove</button>
  `;

  $('copySelected').addEventListener('click', async () => {
    await navigator.clipboard.writeText([...state.selected].join('\n'));
    alert(`Copied ${state.selected.size} URLs!`);
  });

  $('copyMD').addEventListener('click', async () => {
    const md = [...state.selected]
      .map((url) => {
        const it = state.items.find((i) => i.url === url);
        return it && it.directImage ? `![](${it.directImage})` : `[image page](${url})`;
      })
      .join('\n');
    await navigator.clipboard.writeText(md);
    alert(`Copied ${state.selected.size} Markdown embeds!`);
  });

  $('openSelected').addEventListener('click', () => {
    const all = [...state.selected];
    if (!all.length) return;
    if (all.length > 10 && !confirm(`Open the first 10 of ${all.length} images in new tabs?`)) return;
    all.slice(0, 10).forEach((url) => {
      const it = state.items.find((i) => i.url === url);
      chrome.tabs.create({ url: (it && it.directImage) || url });
    });
  });

  $('selectAllPage').addEventListener('click', () => {
    state.pageItems.forEach((i) => state.selected.add(i.url));
    syncSelectionUI();
  });

  $('deselectAll').addEventListener('click', () => {
    state.selected.clear();
    syncSelectionUI();
  });

  $('bulkMove').addEventListener('click', () => showMoveToModal([...state.selected]));

  $('bulkQueryMove').addEventListener('click', () => moveToQueryFolder([...state.selected]));

  $('bulkRemove').addEventListener('click', () => {
    removeItems([...state.selected], state.folderId === 'removed', true);
  });
}

/* ---------------- ZIP download ---------------- */

function safeFilename(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getBaseNameFromUrl(url, index) {
  try {
    const name = new URL(url).pathname.split('/').filter(Boolean).pop();
    return name || `image_${index + 1}.jpg`;
  } catch {
    return `image_${index + 1}.jpg`;
  }
}

function makeFilename(item, index, used) {
  const original = safeFilename(getBaseNameFromUrl(item.directImage, index));
  const prefix = safeFilename(settings.filenamePrefix || '');

  let name = settings.filenameFormat === 'custom' && prefix ? `${prefix}_${index + 1}` : original;
  if (!/\.[a-z0-9]+$/i.test(name)) name += '.jpg';

  if (settings.handleDuplicates !== false) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    let n = 1;
    while (used.has(candidate)) candidate = `${base}_${n++}${ext}`;
    name = candidate;
  }

  used.add(name);
  return name;
}

async function downloadAsZIP() {
  if (typeof JSZip === 'undefined') {
    alert('Error: jszip.min.js not found!');
    return;
  }

  let items = state.selected.size
    ? state.items.filter((i) => state.selected.has(i.url))
    : state.items.filter((i) => i.folder === state.folderId);

  if (!items.length) {
    alert('No images to download');
    return;
  }

  // Apply deduplication if enabled
  if (settings.dedupeResults !== false) {
    const imageObjects = items.map(i => ({
      url: i.directImage || i.url,
      width: i.width || 0,
      height: i.height || 0
    }));
    const deduped = deduplicateImages(imageObjects);
    const dedupedUrls = new Set(deduped.map(img => img.url));
    items = items.filter(i => dedupedUrls.has(i.directImage || i.url));
  }

  // Apply quality filter if enabled
  if (settings.minQualityFilter !== false) {
    items = items.filter(i => {
      if (!i.directImage) return true;
      if (i.width && i.width < 100) return false;
      if (i.height && i.height < 100) return false;
      return true;
    });
  }

  if (!items.length) {
    alert('No images match the current filters');
    return;
  }

  const progressInfo = $('progressInfo');
  const progressFill = $('progressFill');
  const progressText = $('progressText');
  if (progressInfo) progressInfo.classList.add('show');

  const zip = new JSZip();
  const usedNames = new Set();
  const failed = [];

  let downloaded = 0;
  let skipped = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (!item.directImage) {
      skipped++;
      continue;
    }

    if (progressText) progressText.textContent = `Processing ${i + 1} of ${items.length}...`;
    if (progressFill) progressFill.style.width = `${((i + 1) / items.length) * 90}%`;

    const filename = makeFilename(item, i, usedNames);

    try {
      const res = await fetch(item.directImage);
      if (res.ok) {
        zip.file(filename, await res.blob());
        downloaded++;
      } else {
        skipped++;
        if (settings.skipFailedImages === false) failed.push(item.directImage);
      }
    } catch {
      skipped++;
      if (settings.skipFailedImages === false) failed.push(item.directImage);
    }

    await sleep(50);
  }

  if (failed.length) zip.file('failed_images.txt', failed.join('\n'));

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zipBlob);
  a.download = `${settings.zipFilename || 'images'}.zip`;
  a.click();
  URL.revokeObjectURL(a.href);

  if (progressText) progressText.textContent = `Done! ${downloaded} saved, ${skipped} skipped.`;
  setTimeout(() => { if (progressInfo) progressInfo.classList.remove('show'); }, 4000);
}

/* ---------------- backup / restore / gallery ---------------- */

function downloadText(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function exportBackup() {
  const all = await storageGet(null);
  const payload = {
    app: 'image-vault-backup',
    version: 7,
    exportedAt: new Date().toISOString(),
    data: all
  };
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  downloadText(`image-vault-backup-${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json');
  showToast('Backup downloaded', null);
}

async function handleRestoreFile(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;

  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const data = payload && payload.data ? payload.data : payload;

    if (!Array.isArray(data.collected_items)) throw new Error('invalid backup');

    if (!confirm(`Restore ${data.collected_items.length} items? This replaces your current library.`)) return;

    await storageSet(data);
    await loadData();
    await restorePageGroupState();
    await restoreViewState();
    state.selected.clear();
    applyDisplayInputs();
    applySettingsToForm();
    render();
    showToast(`Restored ${data.collected_items.length} items`, null);
  } catch {
    alert('Invalid backup file.');
  }
}

function exportGallery() {
  const items = state.selected.size
    ? state.items.filter((i) => state.selected.has(i.url))
    : state.items.filter((i) => i.folder === state.folderId);

  if (!items.length) {
    alert('Nothing to export here.');
    return;
  }

  const title = state.folderId === 'root'
    ? 'All'
    : (getFolder(state.folderId)?.name || 'Gallery');

  const cards = items
    .map((i) => `<a class="c" href="${esc(i.url)}" target="_blank" rel="noopener">
      <img src="${esc(getThumb(i))}" alt="" loading="lazy">
      <span>${esc(i.directImage || i.url)}</span>
    </a>`)
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Image Gallery</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#16130f;color:#efe7da;font-family:system-ui,sans-serif;padding:34px 22px 70px}
h1{font-size:28px;letter-spacing:.02em}
.sub{color:#9a8d7a;font-size:11px;margin:6px 0 28px;letter-spacing:.18em;text-transform:uppercase;font-family:ui-monospace,monospace}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}
.c{display:block;background:#1f1a15;border:1px solid #3a3128;border-radius:6px;overflow:hidden;text-decoration:none;color:#9a8d7a;transition:transform .18s,border-color .18s,box-shadow .18s}
.c:hover{transform:translateY(-3px);border-color:#f5a83c;box-shadow:0 10px 24px rgba(0,0,0,.45)}
.c img{width:100%;height:190px;object-fit:contain;background:#0c0a07;display:block}
.c span{display:block;font-size:10px;padding:8px 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,monospace}
</style>
</head>
<body>
<h1>🖼️ ${esc(title)}</h1>
<p class="sub">${items.length} images · exported ${new Date().toLocaleDateString()} · Image Vault</p>
<div class="grid">${cards}</div>
</body>
</html>`;

  downloadText(`gallery-${slugify(title)}.html`, html, 'text/html');
  showToast('HTML gallery downloaded', null);
}

/* ---------------- settings ---------------- */

function applySettingsToForm() {
  const filenameFormat = $('filenameFormat');
  if (filenameFormat) filenameFormat.value = settings.filenameFormat || 'original';
  const filenamePrefix = $('filenamePrefix');
  if (filenamePrefix) filenamePrefix.value = settings.filenamePrefix || '';
  const handleDuplicates = $('handleDuplicates');
  if (handleDuplicates) handleDuplicates.checked = settings.handleDuplicates !== false;
  const zipFilename = $('zipFilename');
  if (zipFilename) zipFilename.value = settings.zipFilename || 'images';
  const skipFailedImages = $('skipFailedImages');
  if (skipFailedImages) skipFailedImages.checked = settings.skipFailedImages !== false;
  const dedupeResults = $('dedupeResults');
  if (dedupeResults) dedupeResults.checked = settings.dedupeResults !== false;
  const minQualityFilter = $('minQualityFilter');
  if (minQualityFilter) minQualityFilter.checked = settings.minQualityFilter !== false;
}

async function saveSettingsForm() {
  settings = {
    filenameFormat: $('filenameFormat')?.value || 'original',
    filenamePrefix: $('filenamePrefix')?.value || '',
    handleDuplicates: !!$('handleDuplicates')?.checked,
    zipFilename: $('zipFilename')?.value || 'images',
    skipFailedImages: !!$('skipFailedImages')?.checked,
    dedupeResults: !!$('dedupeResults')?.checked,
    minQualityFilter: !!$('minQualityFilter')?.checked
  };
  await storageSet({ collector_settings: settings });
  $('settingsModal')?.classList.remove('show');
}

function applyDisplayInputs() {
  const gridSize = $('gridSize');
  if (gridSize) gridSize.value = state.display.gridSize;
  setText('gridSizeValue', `${state.display.gridSize}px`);

  const imageHeight = $('imageHeight');
  if (imageHeight) imageHeight.value = state.display.imageHeight;
  setText('imageHeightValue', `${state.display.imageHeight}px`);

  const gap = $('gap');
  if (gap) gap.value = state.display.gap;
  setText('gapValue', `${state.display.gap}px`);

  const showUrls = $('showUrls');
  if (showUrls) showUrls.checked = state.display.showUrls;

  const itemsPerPageInput = $('itemsPerPageInput');
  if (itemsPerPageInput) itemsPerPageInput.value = state.perPage;
}

/* ---------------- init ---------------- */

document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  await restorePageGroupState();
  await restoreViewState();

  const searchFilter = $('searchFilter');
  if (searchFilter) searchFilter.value = state.search;

  const sortSelect = $('sortSelect');
  if (sortSelect) sortSelect.value = state.sort;

  const favFilter = $('favFilter');
  if (favFilter) favFilter.classList.toggle('active', state.favOnly);

  const gifFilter = $('gifFilter');
  if (gifFilter) gifFilter.classList.toggle('active', state.gifOnly);

  applyDisplayInputs();
  applySettingsToForm();
  render();

  on('searchFilter', 'input', (e) => {
    state.search = e.target.value.toLowerCase();
    state.page = 1;
    render();
  });

  on('sortSelect', 'change', (e) => {
    state.sort = e.target.value;
    state.page = 1;
    render();
  });

  on('favFilter', 'click', () => {
    state.favOnly = !state.favOnly;
    $('favFilter').classList.toggle('active', state.favOnly);
    state.page = 1;
    render();
  });

  on('gifFilter', 'click', () => {
    state.gifOnly = !state.gifOnly;
    $('gifFilter').classList.toggle('active', state.gifOnly);
    state.page = 1;
    render();
  });

  on('pageGroupBtn', 'click', async () => {
    if (pageGroup.byFolder[state.folderId]) await disablePageGrouping();
    else await enablePageGrouping();
  });

  on('pageGroupSubBtn', 'click', async () => {
    if (pageGroup.byFolder['__sub__' + state.folderId]) await disablePageGroupingSub();
    else await enablePageGroupingSub();
  });

  on('pageGroupAllBtn', 'click', async () => {
    if (pageGroup.byFolder['__all__']) await disablePageGroupingAll();
    else await enablePageGroupingAll();
  });

  on('verifyGifsBtn', 'click', verifyAllGifs);

  on('dupesBtn', 'click', findDuplicates);
  on('closeDupes', 'click', () => $('dupesModal')?.classList.remove('show'));
  on('mergeAllDupes', 'click', async () => {
    if (!dupeClusters.length) return;

    const keeperUrls = new Set(dupeClusters.map((g) => pickKeeper(g).url));
    const loserUrls = new Set();
    dupeClusters.forEach((g) => g.forEach((i) => { if (!keeperUrls.has(i.url)) loserUrls.add(i.url); }));
    const prev = state.items
      .filter((i) => loserUrls.has(i.url))
      .map((i) => ({ url: i.url, folder: i.folder }));

    let n = 0;
    for (const g of dupeClusters) n += await mergeDupeGroup(g, true);

    state.selected.clear();
    await saveData();
    render();

    dupeClusters = [];
    $('dupesBody').innerHTML = '<div class="dupes-empty">✅ All duplicates merged.</div>';
    $('mergeAllDupes').style.display = 'none';

    showToast(`Merged ${n} duplicates into Trash`, () => {
      prev.forEach((p) => {
        const it = state.items.find((i) => i.url === p.url);
        if (it) it.folder = p.folder;
      });
      saveData();
      render();
    });
  });

  on('newFolderBtn', 'click', async () => {
    const name = prompt('Enter new folder name:');
    if (!name || !name.trim()) return;
    state.folders.push({ id: 'folder_' + Date.now(), name: name.trim(), parent: state.folderId });
    await saveData();
    render();
  });

  on('download', 'click', downloadAsZIP);
  on('galleryBtn', 'click', exportGallery);
  on('backupBtn', 'click', exportBackup);
  on('restoreBtn', 'click', () => $('restoreInput')?.click());
  on('restoreInput', 'change', handleRestoreFile);
  on('statsBtn', 'click', showStats);
  on('closeStats', 'click', () => $('statsModal')?.classList.remove('show'));

  on('settingsBtn', 'click', () => {
    applySettingsToForm();
    $('settingsModal')?.classList.add('show');
  });

  on('closeSettings', 'click', () => $('settingsModal')?.classList.remove('show'));
  on('closeMoveTo', 'click', () => $('moveToModal')?.classList.remove('show'));

  on('refresh', 'click', async () => {
    await loadData();
    state.selected.clear();
    state.search = '';
    const sf = $('searchFilter');
    if (sf) sf.value = '';
    applyDisplayInputs();
    applySettingsToForm();
    render();
  });

  on('showTrash', 'click', () => {
    state.folderId = 'removed';
    state.page = 1;
    state.selected.clear();
    render();
  });

  on('prevPage', 'click', () => {
    if (state.page > 1) {
      state.page--;
      render();
    }
  });

  on('nextPage', 'click', () => {
    state.page++;
    render();
  });

  on('gridSize', 'input', (e) => {
    state.display.gridSize = parseInt(e.target.value, 10) || 250;
    setText('gridSizeValue', `${state.display.gridSize}px`);
    applyDisplaySettings();
    saveDisplay();
  });

  on('imageHeight', 'input', (e) => {
    state.display.imageHeight = parseInt(e.target.value, 10) || 200;
    setText('imageHeightValue', `${state.display.imageHeight}px`);
    applyDisplaySettings();
    saveDisplay();
  });

  on('gap', 'input', (e) => {
    state.display.gap = parseInt(e.target.value, 10) || 20;
    setText('gapValue', `${state.display.gap}px`);
    applyDisplaySettings();
    saveDisplay();
  });

  on('itemsPerPageInput', 'input', (e) => {
    const val = parseInt(e.target.value, 10) || 1;
    state.perPage = Math.max(1, Math.min(200, val));
    state.page = 1;
    render();
    saveDisplay();
  });

  on('showUrls', 'change', (e) => {
    state.display.showUrls = !!e.target.checked;
    applyDisplaySettings();
    saveDisplay();
  });

  on('saveSettings', 'click', saveSettingsForm);

  /* lightbox wiring */
  on('lbClose', 'click', closeLightbox);
  on('lbPrev', 'click', () => lbStep(-1));
  on('lbNext', 'click', () => lbStep(1));
  on('lbMagnify', 'click', toggleMagnify);
  on('lbSlideshow', 'click', toggleSlideshow);
  on('lbSave', 'click', lbSave);

  on('lbStar', 'click', async () => {
    const item = state.pageItems[lightboxState.index];
    if (!item) return;
    item.fav = !item.fav;
    await saveData();
    updateLbStar();
    const card = document.querySelector(`.grid-item[data-url="${CSS.escape(item.url)}"]`);
    if (card) {
      const chip = card.querySelector('.fav-chip');
      if (chip) {
        chip.textContent = item.fav ? '⭐' : '☆';
        chip.classList.toggle('on', !!item.fav);
      }
      card.classList.toggle('fav', !!item.fav);
    }
    if (state.favOnly && !item.fav) render();
  });

  const lb = $('lightbox');
  if (lb) {
    lb.addEventListener('click', (e) => {
      if (e.target === lb) closeLightbox();
    });
  }

  const lbImg = $('lbImage');
  if (lbImg) {
    lbImg.addEventListener('load', fitLightboxImage);
    lbImg.addEventListener('mousemove', updateLoupe);
    lbImg.addEventListener('mouseleave', () => {
      const loupe = $('lbLoupe');
      if (loupe) loupe.classList.remove('show');
    });
    lbImg.addEventListener('wheel', (e) => {
      if (!magState.enabled) return;
      e.preventDefault();
      magState.zoom = Math.min(8, Math.max(1.5, magState.zoom + (e.deltaY < 0 ? 0.5 : -0.5)));
      updateLoupe(e);
    }, { passive: false });
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.item-menu')) hideAllMenus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'Escape') {
      if (isLightboxOpen()) {
        closeLightbox();
        return;
      }
      if (state.selected.size) {
        state.selected.clear();
        syncSelectionUI();
      }
      return;
    }

    if (isLightboxOpen()) {
      if (e.key === 'ArrowRight') { e.preventDefault(); lbStep(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); lbStep(-1); }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      state.pageItems.forEach((i) => state.selected.add(i.url));
      syncSelectionUI();
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!state.selected.size) return;
      e.preventDefault();
      removeItems([...state.selected], state.folderId === 'removed', true);
    }
  });
});