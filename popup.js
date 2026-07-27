const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => { const node = $(id); if (node) node.addEventListener(ev, fn); };
const setText = (id, txt) => { const node = $(id); if (node) node.textContent = txt; };

const sharedLib = globalThis.CollectorShared || {};
const getVisibleItems = sharedLib.getVisibleItems;
const isGifUrl = sharedLib.isGifUrl;

const PLACEHOLDER_IMG = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="70" height="70"><rect fill="#f1f3f4" width="70" height="70"/><text fill="#5f6368" x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="10" font-family="sans-serif">No img</text></svg>'
)}`;

let searchQuery = '';
let lastCount = -1;
let toastTimer = null;
let clearArmed = false;
let clearTimer = null;
let lastCleared = null;

/* ---------------- helpers ---------------- */

async function getItems() {
  const res = await chrome.storage.local.get(['collected_items']);
  return Array.isArray(res.collected_items) ? res.collected_items : [];
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function toast(msg, opts = {}) {
  const t = $('toast');
  setText('toastMsg', msg);
  const undoBtn = $('toastUndo');
  undoBtn.style.display = opts.undo ? '' : 'none';
  if (opts.undo) undoBtn.onclick = () => { opts.undo(); hideToast(); };
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, opts.undo ? 6000 : 2600);
}

function hideToast() {
  $('toast').classList.remove('show');
}

function setCount(n) {
  if (n === lastCount) return;
  lastCount = n;
  setText('countNum', String(n));
  const chip = $('count');
  chip.classList.remove('tick');
  void chip.offsetWidth;
  chip.classList.add('tick');
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

function updateAutoDot() {
  chrome.storage.local.get(['auto_capture_enabled'], (res) => {
    const active = !!res.auto_capture_enabled;
    $('autoDot').classList.toggle('on', active);
    setText('autoLabel', active ? 'auto' : 'manual');
  });
}

/* send a message to a tab — and if the content script isn't there yet
   (tab was opened before the last extension reload), inject it on the spot.
   This is what kills the need for F5. */
function sendToTab(tab, message, cb) {
  chrome.tabs.sendMessage(tab.id, message, (resp) => {
    if (!chrome.runtime.lastError) {
      if (cb) cb(resp);
      return;
    }
    chrome.scripting.executeScript(
      { target: { tabId: tab.id }, files: ['shared.js', 'content_script.js'] },
      () => {
        if (chrome.runtime.lastError) {
          toast("Can't run on this page (restricted URL)");
          return;
        }
        chrome.tabs.sendMessage(tab.id, message, (resp2) => {
          void chrome.runtime.lastError;
          if (cb) cb(resp2);
        });
      }
    );
  });
}

function notifyActiveTab(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.url || !tab.url.startsWith('http')) return;
    sendToTab(tab, message);
  });
}

/* ---------------- list ---------------- */

async function renderList(items) {
  const content = $('content');
  if (!content) return;

  const res = await chrome.storage.local.get(['hide_previews']);
  const hideList = !!res.hide_previews;
  $('listSection').style.display = hideList ? 'none' : '';
  if (hideList) return;

  let visible = getVisibleItems(items).slice().reverse(); /* newest first */
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    visible = visible.filter((i) =>
      (i.url || '').toLowerCase().includes(q) ||
      (i.directImage || '').toLowerCase().includes(q)
    );
  }

  setText('recentCount', String(visible.length));
  content.innerHTML = '';

  if (!visible.length) {
    content.innerHTML = `
      <div class="empty">
        <span class="big">🖼️</span>
        ${searchQuery ? 'Nothing matches your filter.' : 'Nothing collected yet.<br>Open Google Images and hit Fetch.'}
      </div>
    `;
    return;
  }

  visible.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.animationDelay = `${Math.min(idx * 22, 240)}ms`;

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.title = 'Open image';
    const img = document.createElement('img');
    img.src = item.thumb || item.directImage || PLACEHOLDER_IMG;
    img.alt = '';
    img.onerror = () => { img.src = PLACEHOLDER_IMG; };
    thumb.appendChild(img);
    thumb.onclick = () => window.open(item.directImage || item.url, '_blank');
    row.appendChild(thumb);

    const meta = document.createElement('div');
    meta.className = 'meta';

    const url = document.createElement('a');
    url.className = 'url';
    url.href = item.url;
    url.target = '_blank';
    url.textContent = item.url;
    url.title = 'Open source page';
    meta.appendChild(url);

    const sub = document.createElement('div');
    sub.className = 'sub';
    const host = document.createElement('span');
    host.className = 'host';
    host.textContent = hostOf(item.directImage || item.url) || 'page';
    sub.appendChild(host);
    if (isGifUrl(item.directImage)) {
      const gif = document.createElement('span');
      gif.className = 'gif-tag';
      gif.textContent = 'GIF';
      sub.appendChild(gif);
    }
    meta.appendChild(sub);
    row.appendChild(meta);

    const acts = document.createElement('div');
    acts.className = 'acts';

    const copyPage = document.createElement('button');
    copyPage.textContent = '📋';
    copyPage.title = 'Copy page URL';
    copyPage.onclick = async () => {
      await navigator.clipboard.writeText(item.url);
      toast('Page URL copied');
    };
    acts.appendChild(copyPage);

    if (item.directImage) {
      const copyImg = document.createElement('button');
      copyImg.textContent = '🖼';
      copyImg.title = 'Copy direct image URL';
      copyImg.onclick = async () => {
        await navigator.clipboard.writeText(item.directImage);
        toast('Image URL copied');
      };
      acts.appendChild(copyImg);
    }

    row.appendChild(acts);
    content.appendChild(row);
  });
}

async function loadStored() {
  const items = await getItems();
  setCount(getVisibleItems(items).length);
  renderList(items);
  updateStorageMeter();
  updateAutoDot();
}

/* ---------------- actions ---------------- */

function fetchFromPage() {
  const btn = $('fetch');

  const resetBtn = () => {
    btn.classList.remove('working', 'success');
    btn.textContent = '⛏ Fetch from Page';
  };

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.url || !tab.url.startsWith('http')) {
      toast('Open a webpage first');
      return;
    }

    btn.classList.add('working');
    btn.textContent = '⏳ Scanning…';

    sendToTab(tab, { type: 'request_page_urls' }, (resp) => {
      if (!resp) {
        resetBtn();
        toast('Could not connect to the page');
        return;
      }

      const urls = Array.isArray(resp.urls) ? resp.urls : [];
      const images = Array.isArray(resp.images) ? resp.images : [];

      const done = (n) => {
        btn.classList.remove('working');
        btn.classList.add('success');
        btn.textContent = n > 0 ? `✓ +${n} new` : '✓ Nothing new';
        setTimeout(resetBtn, 1700);
        loadStored();
      };

      if (urls.length) {
        console.log('[popup.js] save_urls:', { count: urls.length });
        chrome.runtime.sendMessage({ type: 'save_urls', urls }, (r2) => {
          void chrome.runtime.lastError;
          done(r2 && typeof r2.saved === 'number' ? r2.saved : urls.length);
        });
      } else if (images.length) {
        chrome.runtime.sendMessage(
          { type: 'save_generic', pageUrl: resp.pageUrl || tab.url, images },
          (r2) => {
            void chrome.runtime.lastError;
            done(r2 && typeof r2.saved === 'number' ? r2.saved : images.length);
          }
        );
      } else {
        resetBtn();
        toast('No images found — scroll down to load more');
      }
    });
  });
}

async function copyAll() {
  const urls = getVisibleItems(await getItems()).map((i) => i.url).filter(Boolean);
  if (!urls.length) return toast('Nothing to copy');
  await navigator.clipboard.writeText(urls.join('\n'));
  toast(`Copied ${urls.length} URLs`);
}

async function copyMd() {
  const items = getVisibleItems(await getItems());
  if (!items.length) return toast('Nothing to copy');
  const md = items
    .map((i) => (i.directImage ? `![](${i.directImage})` : `[image page](${i.url})`))
    .join('\n');
  await navigator.clipboard.writeText(md);
  toast(`Copied ${items.length} Markdown embeds`);
}

async function saveTxt() {
  const urls = getVisibleItems(await getItems()).map((i) => i.url).filter(Boolean);
  if (!urls.length) return toast('Nothing to save');
  const blob = new Blob([urls.join('\n')], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'collected_urls.txt';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Downloading .txt');
}

async function downloadZip() {
  const items = getVisibleItems(await getItems());
  if (!items.length) return toast('Nothing to download');

  // Load JSZip dynamically from CDN if not available
  if (!window.JSZip) {
    try {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      await new Promise((resolve, reject) => {
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    } catch (err) {
      return toast('Failed to load ZIP library. Check internet connection.');
    }
  }

  const zip = new window.JSZip();
  const btn = $('downloadZip');
  const originalText = btn.innerHTML;
  
  // Show progress
  btn.innerHTML = '⏳<span>Zipping...</span>';
  btn.disabled = true;

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const url = item.directImage || item.url;
    if (!url) continue;

    try {
      // Generate filename from URL
      const urlObj = new URL(url);
      const pathname = urlObj.pathname.split('/').pop() || `image_${i}`;
      const ext = pathname.split('.').pop() || 'jpg';
      const filename = `image_${String(i).padStart(4, '0')}.${ext}`;

      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      zip.file(filename, blob);
      successCount++;
    } catch (err) {
      console.warn(`Failed to download ${url}:`, err);
      failCount++;
    }
  }

  try {
    const content = await zip.generateAsync({ type: 'blob' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = `image_vault_${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);

    let msg = `Downloaded ${successCount} images`;
    if (failCount > 0) msg += ` (${failCount} failed)`;
    toast(msg);
  } catch (err) {
    toast('Failed to create ZIP file');
    console.error(err);
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

function disarmClear() {
  clearArmed = false;
  clearTimeout(clearTimer);
  const btn = $('clear');
  btn.classList.remove('armed');
  btn.innerHTML = '✕<span>Clear</span>';
}

async function handleClear() {
  const btn = $('clear');

  if (!clearArmed) {
    clearArmed = true;
    btn.classList.add('armed');
    btn.innerHTML = '✕<span>Sure?</span>';
    clearTimer = setTimeout(disarmClear, 2600);
    return;
  }

  disarmClear();
  const items = await getItems();
  const visibleCount = getVisibleItems(items).length;
  if (!visibleCount) return toast('Library is already empty');

  lastCleared = items;
  await chrome.storage.local.set({ collected_items: [] });
  loadStored();
  toast(`Cleared ${visibleCount} items`, {
    undo: async () => {
      if (lastCleared) {
        await chrome.storage.local.set({ collected_items: lastCleared });
        loadStored();
        toast('Library restored');
      }
    }
  });
}

/* ---------------- toggles ---------------- */

function getFirstElement(ids) {
  for (const id of ids) {
    const node = $(id);
    if (node) return node;
  }
  return null;
}

async function bindToggle(ids, storageKey, defaultValue, afterChange) {
  const checkbox = getFirstElement(ids);
  if (!checkbox) return;

  const res = await chrome.storage.local.get([storageKey]);
  checkbox.checked = typeof res[storageKey] === 'boolean' ? res[storageKey] : defaultValue;

  checkbox.addEventListener('change', async () => {
    await chrome.storage.local.set({ [storageKey]: checkbox.checked });
    if (afterChange) afterChange(checkbox.checked);
  });

  if (afterChange) afterChange(checkbox.checked);
}

/* ---------------- init ---------------- */

document.addEventListener('DOMContentLoaded', () => {
  on('fetch', 'click', fetchFromPage);
  on('copyAll', 'click', copyAll);
  on('copyMd', 'click', copyMd);
  on('saveTxt', 'click', saveTxt);
  on('downloadZip', 'click', downloadZip);
  on('clear', 'click', handleClear);

  on('openGrid', 'click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('grid.html') });
  });

  on('controlsBtn', 'click', () => {
    const panel = $('controlsPanel');
    const open = panel.classList.toggle('open');
    $('controlsBtn').classList.toggle('active', open);
  });

  on('searchInput', 'input', async (e) => {
    searchQuery = e.target.value.trim();
    renderList(await getItems());
  });

  bindToggle(['hoverToggle', 'hoverEnabled'], 'hover_enabled', true);
  bindToggle(['tolnsToggle', 'filterTolns', 'tolnsFilter', 'filterTolnsToggle'], 'filter_tolns', false);
  bindToggle(
    ['autoCaptureToggle', 'autoCapture'],
    'auto_capture_enabled',
    false,
    (enabled) => {
      notifyActiveTab({ type: 'toggle_auto_capture', enabled });
      updateAutoDot();
    }
  );
  bindToggle(['autoFolderToggle', 'autoFolder'], 'auto_folder_by_query', false);
  bindToggle(['hidePreviewsToggle', 'hidePreviews'], 'hide_previews', false, () => loadStored());
  bindToggle(
    ['highlightToggle', 'highlightSaved'],
    'highlight_collected',
    false,
    (enabled) => notifyActiveTab({ type: 'toggle_highlight', enabled })
  );
  bindToggle(['dedupeToggle', 'dedupeResults'], 'dedupe_results', true);
  bindToggle(['qualityToggle', 'minQuality'], 'min_quality_filter', true);

  /* live refresh while the popup is open */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.collected_items || changes.auto_capture_enabled)) {
      loadStored();
    }
  });

  loadStored();
});