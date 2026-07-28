/* ---------- shared helpers (self-sufficient) ----------
   Loads shared.js when present, but falls back to inline copies so the
   worker NEVER dies at startup if that file is missing or fails to load. */
try {
  importScripts('shared.js');
} catch (e) {
  console.warn('shared.js not loaded — using inline helpers', e);
}

const shared = globalThis.CollectorShared || {};

const IMGRES_PREFIX = shared.IMGRES_PREFIX || 'https://www.google.com/imgres?q=';

const normalizeUrl = shared.normalizeUrl || ((raw) => {
  try {
    const u = new URL(raw);
    u.searchParams.delete('ved');
    u.searchParams.delete('vet');
    u.hash = '';
    const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    return `${u.origin}${u.pathname}?${new URLSearchParams(params).toString()}`;
  } catch { return raw; }
});

const extractDirectImage = shared.extractDirectImage || ((googleUrl) => {
  try {
    const u = new URL(googleUrl);
    if (u.hostname.includes('google.com') && u.pathname === '/imgres') {
      const imgurl = u.searchParams.get('imgurl');
      if (imgurl) return decodeURIComponent(imgurl);
    }
  } catch {}
  return null;
});

const extractThumbnail = shared.extractThumbnail || ((googleUrl) => {
  try {
    const u = new URL(googleUrl);
    if (u.hostname.includes('google.com') && u.pathname === '/imgres') {
      const tbnid = u.searchParams.get('tbnid');
      if (tbnid) return `https://encrypted-tbn0.gstatic.com/images?q=tbn:${tbnid}`;
    }
  } catch {}
  return null;
});

const extractQuery = shared.extractQuery || ((googleUrl) => {
  try {
    const u = new URL(googleUrl);
    if (u.pathname === '/imgres') {
      const q = u.searchParams.get('q');
      if (q) return decodeURIComponent(q).trim();
    }
  } catch {}
  return null;
});

const isGifUrl = shared.isGifUrl || ((url) => /\.gif(\?|#|$)/i.test(String(url || '')));

const slugify = shared.slugify || ((s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'search');

/* ---------- right-click context menus ----------
   Guarded so a missing "contextMenus" permission can't crash the worker. */
if (chrome.contextMenus) {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({ id: 'vault_save_image', title: '💾 Save image to Image Vault', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'vault_save_link', title: '🔗 Save link to Image Vault', contexts: ['link'] });
  });

  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === 'vault_save_image' && info.srcUrl) {
      addItems([{ url: info.pageUrl || info.srcUrl, directImage: info.srcUrl }],
        (n) => flashBadge(n ? `+${n}` : '='));
    }
    if (info.menuItemId === 'vault_save_link' && info.linkUrl) {
      const entry = info.linkUrl.startsWith(IMGRES_PREFIX)
        ? { url: info.linkUrl, directImage: extractDirectImage(info.linkUrl) }
        : { url: info.linkUrl, directImage: null };
      addItems([entry], (n) => flashBadge(n ? `+${n}` : '='));
    }
  });
}

function flashBadge(text) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#f5a83c' });
    chrome.action.setBadgeText({ text });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500);
  } catch {}
}

/* ---------- core: dedupe + auto-folder + timestamps ---------- */

function addItems(incoming, done) {
  chrome.storage.local.get(['collected_items', 'folders', 'auto_folder_by_query'], (res) => {
    const existing = Array.isArray(res.collected_items) ? res.collected_items : [];
    const autoFolder = !!res.auto_folder_by_query;
    let folders = Array.isArray(res.folders) && res.folders.length ? res.folders : null;

    const seenUrl = new Set(existing.map((i) => normalizeUrl(i.url)));
    const seenImg = new Set(existing.map((i) => i.directImage).filter(Boolean));
    const toAdd = [];
    const now = Date.now();

    const ensureQueryFolder = (query) => {
      if (!folders) {
        folders = [
          { id: 'root', name: 'All', parent: null },
          { id: 'removed', name: '🗑️ Trash', parent: null, hidden: true }
        ];
      }
      const id = 'qf_' + slugify(query);
      let f = folders.find((x) => x.id === id);
      if (!f) {
        f = { id, name: query.slice(0, 40), parent: 'root' };
        folders.push(f);
      }
      return id;
    };

    for (const entry of incoming) {
      if (!entry || typeof entry.url !== 'string') continue;

      const nUrl = normalizeUrl(entry.url);
      const img = entry.directImage || null;

      /* dedupe by direct image first, then by normalized page URL */
      if (img && seenImg.has(img)) continue;
      if (!img && seenUrl.has(nUrl)) continue;
      if (img) seenImg.add(img);
      seenUrl.add(nUrl);

      let folder = 'root';
      if (autoFolder) {
        const q = extractQuery(entry.url);
        if (q) folder = ensureQueryFolder(q);
      }

      toAdd.push({
        url: entry.url,
        directImage: img,
        thumb: extractThumbnail(entry.url),
        title: entry.title || '',
        isGif: img ? isGifUrl(img) : false,
        gifChecked: false,
        phash: null,
        folder,
        addedAt: now,
        fav: false
      });
    }

    if (!toAdd.length) { if (done) done(0); return; }

    const update = { collected_items: existing.concat(toAdd) };
    if (folders) update.folders = folders;

    chrome.storage.local.set(update, () => { if (done) done(toAdd.length); });
  });
}

/* ---------- messages ---------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'save_urls') {
    const urls = (Array.isArray(msg.urls) ? msg.urls : [])
      .filter((u) => typeof u === 'string' && u.startsWith(IMGRES_PREFIX));
    const titles = typeof msg.titles === 'object' && msg.titles ? msg.titles : {};
    if (!urls.length) { sendResponse({ saved: 0 }); return true; }
    addItems(urls.map((u) => ({ 
      url: u, 
      directImage: extractDirectImage(u),
      title: titles[u] || ''
    })),
      (n) => sendResponse({ saved: n }));
    return true;
  }

  if (msg.type === 'save_generic') {
    const page = typeof msg.pageUrl === 'string' && msg.pageUrl ? msg.pageUrl : '';
    const imgs = (Array.isArray(msg.images) ? msg.images : [])
      .filter((s) => typeof s === 'string' && /^https?:/.test(s));
    if (!imgs.length) { sendResponse({ saved: 0 }); return true; }
    addItems(imgs.map((src) => ({ url: page || src, directImage: src })),
      (n) => sendResponse({ saved: n }));
    return true;
  }
});