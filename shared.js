(() => {
  const IMGRES_PREFIX = 'https://www.google.com/imgres?q=';

  function normalizeUrl(raw) {
    try {
      const u = new URL(raw);
      u.searchParams.delete('ved');
      u.searchParams.delete('vet');
      u.hash = '';
      const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
      return `${u.origin}${u.pathname}?${new URLSearchParams(params).toString()}`;
    } catch { return raw; }
  }

  function extractDirectImage(googleUrl) {
    try {
      const u = new URL(googleUrl);
      if (u.hostname.includes('google.com') && u.pathname === '/imgres') {
        const imgurl = u.searchParams.get('imgurl');
        if (imgurl) return decodeURIComponent(imgurl);
      }
    } catch {}
    return null;
  }

  function extractThumbnail(googleUrl) {
    try {
      const u = new URL(googleUrl);
      if (u.hostname.includes('google.com') && u.pathname === '/imgres') {
        const tbnid = u.searchParams.get('tbnid');
        if (tbnid) return `https://encrypted-tbn0.gstatic.com/images?q=tbn:${tbnid}`;
      }
    } catch {}
    return null;
  }

  function extractQuery(googleUrl) {
    try {
      const u = new URL(googleUrl);
      if (u.pathname === '/imgres') {
        const q = u.searchParams.get('q');
        if (q) return decodeURIComponent(q).trim();
      }
    } catch {}
    return null;
  }

  function isGifUrl(url) {
    return /\.gif(\?|#|$)/i.test(String(url || ''));
  }

  function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'search';
  }

  function getVisibleItems(items) {
    return (Array.isArray(items) ? items : []).filter((i) => i && i.folder !== 'removed');
  }

  globalThis.CollectorShared = {
    IMGRES_PREFIX, normalizeUrl, extractDirectImage, extractThumbnail,
    extractQuery, isGifUrl, slugify, getVisibleItems
  };
})();