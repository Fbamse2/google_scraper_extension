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

  /**
   * Deduplicates an array of image objects based on URL and dimensions
   * @param {Array} images - Array of image objects {url, width, height}
   * @returns {Array} - Deduplicated array
   */
  function deduplicateImages(images) {
    const seen = new Map();
    const result = [];

    for (const img of images) {
      // Create a key based on URL and approximate size to catch duplicates
      // We ignore minor dimension differences (e.g., 1px)
      const cleanUrl = img.url.split('?')[0]; // Ignore query params for dedup
      const key = `${cleanUrl}_${Math.floor(img.width / 10) * 10}x${Math.floor(img.height / 10) * 10}`;

      if (!seen.has(key)) {
        seen.set(key, true);
        result.push(img);
      }
    }
    return result;
  }

  /**
   * Filters images based on quality criteria
   * @param {Array} images - Array of image objects
   * @param {Object} options - Filter options {minWidth, minHeight, minSizeKB}
   * @returns {Array} - Filtered array
   */
  function filterImages(images, options = {}) {
    const { minWidth = 100, minHeight = 100, minSizeKB = 0 } = options;
    
    return images.filter(img => {
      if (img.width < minWidth || img.height < minHeight) return false;
      if (img.fileSize && img.fileSize < minSizeKB * 1024) return false;
      return true;
    });
  }

  globalThis.CollectorShared = {
    IMGRES_PREFIX, normalizeUrl, extractDirectImage, extractThumbnail,
    extractQuery, isGifUrl, slugify, getVisibleItems,
    deduplicateImages, filterImages
  };
})();