/* Shared by the content script, settings UI, and tests. */
globalThis.E6Nav = (() => {
  const defaultKey = { code: "BracketRight", alt: false, ctrl: false, shift: false, meta: false };
  const defaultPreviousKey = { code: "BracketLeft", alt: false, ctrl: false, shift: false, meta: false };
  const defaultSeekKey = { code: "ArrowRight", alt: false, ctrl: false, shift: false, meta: false };
  const defaultRewindKey = { code: "ArrowLeft", alt: false, ctrl: false, shift: false, meta: false };
  const defaultSeekPercent = 20;
  function seekPercent(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100 ? value : defaultSeekPercent;
  }
  function sameKey(left, right) {
    return ["code", "alt", "ctrl", "shift", "meta"].every(name => left[name] === right[name]);
  }
  function settings(data) {
    const oldDefault = { code: "KeyN", alt: false, ctrl: false, shift: false, meta: false };
    return {
      nextKey: !data.nextKey || (data.settingsVersion !== 2 && sameKey(data.nextKey, oldDefault)) ? defaultKey : data.nextKey,
      previousKey: data.previousKey || defaultPreviousKey,
      seekKey: data.seekKey || defaultSeekKey,
      rewindKey: data.rewindKey || defaultRewindKey,
      seekPercent: seekPercent(data.seekPercent),
      rewindPercent: seekPercent(data.rewindPercent),
      endMode: data.endMode === "next" ? "next" : "loop",
      language: data.language === "zh" ? "zh" : "en",
      autoPage: data.autoPage === true
    };
  }
  async function loadSettings(storage) {
    const data = await storage.get([...Object.keys(settings({})), "settingsVersion"]);
    const result = settings(data);
    if (data.settingsVersion !== 2) {
      await storage.set({ settingsVersion: 2, ...(data.nextKey && !sameKey(data.nextKey, result.nextKey) ? { nextKey: result.nextKey } : {}) });
    }
    return result;
  }
  const prefix = "e6nav:context:";
  function searchUrl(value, base = "https://e621.net") {
    try {
      const url = new URL(value, base);
      if (url.origin !== "https://e621.net" || !/^\/(posts|favorites)\/?$/.test(url.pathname)) return null;
      url.hash = "";
      return url.href;
    } catch { return null; }
  }
  function nextPage(document, source) {
    const link = document.querySelector('a#paginator-next[href], .pagination a[rel="next"][href], .pagination a.next[href]');
    if (!link || link.getAttribute("aria-disabled") === "true") return null;
    const target = searchUrl(link.getAttribute("href"), source);
    if (!target || target === searchUrl(source) || new URL(target).pathname.replace(/\/$/, "") !== new URL(source).pathname.replace(/\/$/, "")) return null;
    const url = new URL(target);
    // Preserve all original filters, including the complete tags/order query and page size.
    const current = new URL(source);
    for (const name of new Set(current.searchParams.keys())) {
      if (name === "page") continue;
      url.searchParams.delete(name);
      for (const value of current.searchParams.getAll(name)) url.searchParams.append(name, value);
    }
    return pageIdentity(url.href) === pageIdentity(source) ? null : url.href;
  }
  function pageIdentity(value) {
    const source = searchUrl(value);
    if (!source) return null;
    const url = new URL(source);
    // Favorites use a different order from fav:username search results; never merge them.
    url.pathname = url.pathname.replace(/\/$/, "");
    url.searchParams.sort();
    return url.href;
  }
  function postId(value, base = "https://e621.net") {
    try {
      const url = new URL(value, base);
      return url.origin === "https://e621.net" ? url.pathname.match(/^\/posts\/(\d+)\/?$/)?.[1] || null : null;
    } catch { return null; }
  }
  function token(value) {
    const fragment = new URL(value).hash.slice(1);
    const candidate = new URLSearchParams(fragment).get("e6nav");
    return candidate && /^[a-f0-9-]{36}$/.test(candidate) ? candidate : null;
  }
  function withToken(value, id) {
    const url = new URL(value);
    const hash = new URLSearchParams(url.hash.slice(1));
    hash.set("e6nav", id);
    url.hash = hash.toString();
    return url.href;
  }
  function matches(event, key) {
    return event.code === key.code && event.altKey === key.alt && event.ctrlKey === key.ctrl &&
      event.shiftKey === key.shift && event.metaKey === key.meta;
  }
  function editable(event) {
    return event.composedPath().some(el => el?.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName || "") || el?.getAttribute?.("role") === "textbox");
  }
  function label(key, language = "en") {
    const names = { BracketRight: "]", BracketLeft: "[", ArrowRight: "→", ArrowLeft: "←", ArrowUp: "↑", ArrowDown: "↓", Space: language === "en" ? "Space" : "空格" };
    return [key.ctrl && "Ctrl", key.alt && "Alt", key.shift && "Shift", key.meta && "Meta",
      names[key.code] || key.code.replace(/^Key/, "").replace(/^Digit/, "")].filter(Boolean).join(" + ");
  }
  function collect(document, base) {
    const seen = new Set();
    const videos = [];
    const links = [];
    for (const article of document.querySelectorAll("#posts .posts-container > article.thumbnail, #posts article.post-preview")) {
      const link = article.querySelector('a.thm-link, a[href*="/posts/"]');
      if (!link) continue;
      const ext = (article.dataset.fileExt || link.dataset.fileExt || "").toLowerCase();
      if (!["webm", "mp4", "m4v", "mov", "ogv"].includes(ext)) continue;
      const hidden = article.closest('[hidden], .blacklisted, .blacklist-hidden');
      const style = document.defaultView.getComputedStyle(article);
      if (hidden || style.display === "none" || style.visibility === "hidden" || !article.getClientRects().length) continue;
      const url = new URL(link.getAttribute("href"), base);
      const id = postId(url.href);
      if (!id || seen.has(id)) continue;
      // Only our own navigation marker is removed; preserve the site's query parameters.
      const hash = new URLSearchParams(url.hash.slice(1));
      hash.delete("e6nav");
      url.hash = hash.toString();
      seen.add(id);
      videos.push({ id, url: url.href });
      links.push(link);
    }
    return { videos, links };
  }
  return { defaultKey, defaultPreviousKey, defaultSeekKey, defaultRewindKey, defaultSeekPercent, seekPercent, sameKey, settings, loadSettings, prefix, searchUrl, nextPage, pageIdentity, postId, token, withToken, matches, editable, label, collect };
})();
