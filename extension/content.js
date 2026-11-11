(() => {
  "use strict";
  const C = E6Nav;
  let settings = C.settings({});
  let context = null;
  let notice;
  let navigating = false;
  let leavingPage = false;
  let onSettingsChange = () => {};
  let lastNotice = null;
  function renderNotice() {
    if (!notice || !lastNotice) return;
    const params = { ...lastNotice.params };
    if (lastNotice.key === "position") {
      params.previousKey = C.label(settings.previousKey, settings.language);
      params.nextKey = C.label(settings.nextKey, settings.language);
    }
    notice.lang = settings.language === "en" ? "en" : "zh-CN";
    notice.textContent = E6I18n.t(lastNotice.key, settings.language, params);
  }
  function toast(key, params = {}) {
    if (!notice) {
      notice = document.createElement("div");
      notice.setAttribute("role", "status");
      notice.style.cssText = "position:fixed;bottom:24px;left:24px;max-width:420px;background:#142333;color:#fff;padding:14px 18px;border:1px solid #82b9e8;border-radius:8px;font:14px/1.5 system-ui;z-index:2147483647;pointer-events:none;box-shadow:0 4px 18px #0008";
    }
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && fullscreen.tagName !== "VIDEO" ? fullscreen : document.body;
    if (notice.parentElement !== parent) parent.append(notice);
    lastNotice = { key, params };
    renderNotice();
    notice.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { notice.hidden = true; }, 4500);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const patch = Object.fromEntries(Object.keys(settings).filter(name => changes[name]).map(name => [name, changes[name].newValue]));
    settings = C.settings({ ...settings, ...patch, settingsVersion: 2 });
    renderNotice();
    onSettingsChange();
  });
  const ready = C.loadSettings(chrome.storage.local).then(data => { settings = data; });
  let currentId = C.postId(location.href);
  if (currentId) {
    let contextToken = C.token(location.href);
    let fullscreenUrl = null;
    let pendingRequest = null;
    let automaticRequest = false;
    let paginationRequest = false;
    let pageRequest = null;
    let automaticPageRequest = false;
    function fullscreenVideo() {
      const fullscreen = document.fullscreenElement;
      if (!fullscreen) return null;
      return fullscreen.tagName === "VIDEO" ? fullscreen : fullscreen.querySelector("video");
    }
    function mainVideo() {
      return fullscreenVideo() || document.querySelector("video-player video, #image-container video, video#image, video");
    }
    function applyMode(player) {
      const loop = settings.endMode === "loop";
      if (player && player.loop !== loop) player.loop = loop;
    }
    const boundPlayers = new WeakSet();
    function bindPlayer() {
      const player = mainVideo();
      if (!player) return;
      applyMode(player);
      if (boundPlayers.has(player)) return;
      boundPlayers.add(player);
      player.addEventListener("loadedmetadata", () => applyMode(player));
      player.addEventListener("play", () => applyMode(player));
      player.addEventListener("ended", () => {
        if (player === mainVideo() && settings.endMode === "next") navigate(1, true);
      });
    }
    onSettingsChange = () => {
      bindPlayer();
      if ((automaticRequest && settings.endMode !== "next") || (paginationRequest && !settings.autoPage)) pendingRequest?.abort("mode-changed");
      if (!settings.autoPage || (automaticPageRequest && settings.endMode !== "next")) pageRequest?.abort("mode-changed");
    };
    ready.then(bindPlayer);
    new MutationObserver(bindPlayer).observe(document.body, {
      subtree: true, childList: true, attributes: true, attributeFilter: ["loop"]
    });
    const fragment = new URLSearchParams(location.hash.slice(1));
    if (fragment.get("e6play") === "1") {
      fragment.delete("e6play");
      const cleanUrl = new URL(location.href);
      cleanUrl.hash = fragment.toString();
      history.replaceState(history.state, "", cleanUrl.href);
      ready.then(() => {
        const player = mainVideo();
        if (player) player.play().catch(() => toast("autoplayBlocked"));
      });
    }
    function mediaUrl(value, base) {
      const url = new URL(value, base);
      if (url.protocol !== "https:" || !(url.hostname === "e621.net" || url.hostname.endsWith(".e621.net"))) {
        throw new Error("Unexpected media origin");
      }
      return url.href;
    }
    async function switchFullscreen(next, player, direction, automatic, proposedQueue = null) {
      const fullscreen = document.fullscreenElement;
      pendingRequest = new AbortController();
      automaticRequest = automatic;
      paginationRequest = proposedQueue !== null;
      const request = pendingRequest;
      const timeout = setTimeout(() => request.abort(), 20000);
      toast(direction > 0 ? "loadingNext" : "loadingPrevious");
      try {
        const response = await fetch(next.url, { credentials: "same-origin", signal: request.signal });
        if (!response.ok || C.postId(response.url) !== next.id) throw new Error("Unable to load post");
        const html = new DOMParser().parseFromString(await response.text(), "text/html");
        const incoming = html.querySelector("video-player video, #image-container video, video#image, video");
        if (!incoming) throw new Error("Video missing or unavailable");
        const sources = Array.from(incoming.querySelectorAll("source[src]"), source => ({
          url: mediaUrl(source.getAttribute("src"), response.url), type: source.getAttribute("type")
        }));
        const direct = incoming.getAttribute("src");
        if (direct) sources.unshift({ url: mediaUrl(direct, response.url), type: null });
        if (!sources.length) throw new Error("Video source missing");
        // Do not commit a response after the user has exited or changed fullscreen.
        if (request.signal.aborted || document.fullscreenElement !== fullscreen || !player.isConnected) return;
        const playbackRate = player.playbackRate;
        player.pause();
        player.removeAttribute("src");
        player.removeAttribute("poster");
        player.querySelectorAll("source, track").forEach(node => node.remove());
        for (const source of sources) {
          const node = document.createElement("source");
          node.src = source.url;
          if (source.type) node.type = source.type;
          player.append(node);
        }
        for (const name of ["width", "height"]) {
          if (incoming.hasAttribute(name)) player.setAttribute(name, incoming.getAttribute(name));
          else player.removeAttribute(name);
        }
        currentId = next.id;
        if (proposedQueue) { context = proposedQueue.record; contextToken = proposedQueue.token; }
        fullscreenUrl = C.withToken(next.url, contextToken);
        applyMode(player);
        player.load();
        player.playbackRate = playbackRate;
        player.play().catch(() => {
          if (currentId === next.id && document.fullscreenElement) toast("playbackBlocked");
        });
        const position = context.videos.findIndex(video => video.id === currentId);
        toast("position", { position: position + 1, total: context.videos.length });
      } catch (error) {
        if (document.fullscreenElement === fullscreen && request.signal.reason !== "mode-changed") toast("loadError");
      } finally {
        clearTimeout(timeout);
        if (pendingRequest === request) { pendingRequest = null; automaticRequest = false; paginationRequest = false; }
      }
    }
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement) {
        pendingRequest?.abort();
        pageRequest?.abort("fullscreen-exited");
        if (fullscreenUrl) { leavingPage = true; location.assign(fullscreenUrl); }
      }
    });
    const contextReady = (async () => {
      const id = C.token(location.href);
      if (id) context = (await chrome.storage.local.get(C.prefix + id))[C.prefix + id] || null;
      await ready;
      if (context?.videos.some(video => video.id === currentId)) {
        const position = context.videos.findIndex(video => video.id === currentId);
        toast("position", { position: position + 1, total: context.videos.length });
      }
    })();
    async function loadSearchPage(value, signal) {
      const source = C.searchUrl(value);
      if (!source) throw new Error("pageUnavailable");
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        let settled = false;
        function finish(error, record) {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          window.removeEventListener("pagehide", abort);
          if (error) reject(error); else resolve(record);
        }
        function abort() {
          chrome.runtime.sendMessage({ type: "e6:cancel-search", id }).catch(() => {});
          finish(new DOMException("Cancelled", "AbortError"));
        }
        signal.addEventListener("abort", abort, { once: true });
        window.addEventListener("pagehide", abort, { once: true });
        chrome.runtime.sendMessage({ type: "e6:load-search", id, url: source }).then(result => {
          if (!result?.ok) finish(new Error(result?.error || "pageExtensionError"));
          else finish(null, result.record);
        }).catch(() => finish(new Error("pageExtensionError")));
      });
    }
    async function nextPageQueue(automatic) {
      const request = new AbortController();
      pageRequest = request;
      automaticPageRequest = automatic;
      toast("loadingPage");
      try {
        let nextUrl = context.nextPage;
        // Old snapshots remain usable after an upgrade; discover their real pagination link.
        if (nextUrl === undefined) nextUrl = (await loadSearchPage(context.source, request.signal)).nextPage;
        const visited = context.visitedPages || [context.source];
        if (!nextUrl || visited.some(page => C.pageIdentity(page) === C.pageIdentity(nextUrl))) { toast("searchEnd"); return null; }
        const page = await loadSearchPage(nextUrl, request.signal);
        if (request.signal.aborted || !settings.autoPage || (automatic && settings.endMode !== "next")) return null;
        const seen = new Set(context.videos.map(video => video.id));
        const videos = page.videos.filter(video => !seen.has(video.id));
        if (!videos.length) { toast("noPageVideos"); return null; }
        const record = {
          source: page.source, videos: [...context.videos, ...videos], nextPage: page.nextPage,
          visitedPages: [...visited, page.source], createdAt: Date.now()
        };
        const token = crypto.randomUUID();
        await chrome.storage.local.set({ [C.prefix + token]: record });
        if (request.signal.aborted || !settings.autoPage || (automatic && settings.endMode !== "next")) return null;
        return { record, token, first: videos[0] };
      } catch (error) {
        if (!request.signal.aborted) { console.warn("e621 pagination:", error); toast("pageError", { reason: E6I18n.t(error.message, settings.language) }); }
        return null;
      } finally {
        if (pageRequest === request) { pageRequest = null; automaticPageRequest = false; }
      }
    }
    async function navigate(direction, automatic = false) {
      if (navigating || leavingPage) return;
      navigating = true;
      try {
        await contextReady;
        if (automatic && settings.endMode !== "next") return;
        const index = context?.videos.findIndex(video => video.id === currentId) ?? -1;
        if (index < 0) { toast("noContext"); return; }
        let next = context.videos[index + direction];
        let proposedQueue = null;
        if (!next) {
          if (direction > 0 && settings.autoPage) {
            proposedQueue = await nextPageQueue(automatic);
            if (!proposedQueue) return;
            next = proposedQueue.first;
          } else { toast(direction > 0 ? "lastVideo" : "firstVideo"); return; }
        }
        if (!C.postId(next.url)) { toast("invalidLink"); return; }
        const player = fullscreenVideo();
        if (player) await switchFullscreen(next, player, direction, automatic, proposedQueue);
        else {
          const url = new URL(C.withToken(next.url, proposedQueue?.token || contextToken));
          if (automatic || proposedQueue) {
            const hash = new URLSearchParams(url.hash.slice(1));
            hash.set("e6play", "1");
            url.hash = hash.toString();
          }
          leavingPage = true;
          location.assign(url.href);
        }
      } catch { toast("storageError"); }
      finally { navigating = false; }
    }
    window.addEventListener("keydown", async event => {
      if (C.editable(event) || event.isComposing || event.repeat) return;
      const action = ["nextKey", "previousKey", "seekKey", "rewindKey"].find(name => C.matches(event, settings[name]));
      if (!action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      // Navigation has priority if legacy settings contain a shortcut conflict.
      if (action === "seekKey" || action === "rewindKey") {
        if (navigating) return;
        const player = mainVideo();
        if (!player) { toast("noVideo"); return; }
        if (!Number.isFinite(player.duration) || player.duration <= 0) {
          toast("metadataPending"); return;
        }
        try {
          const direction = action === "seekKey" ? 1 : -1;
          const percent = action === "seekKey" ? settings.seekPercent : settings.rewindPercent;
          player.currentTime = Math.max(0, Math.min(player.duration, player.currentTime + direction * player.duration * percent / 100));
          toast(direction > 0 ? "forwardProgress" : "backwardProgress", { percent, progress: Math.round(player.currentTime / player.duration * 100) });
        } catch { toast("seekError"); }
        return;
      }
      await navigate(action === "nextKey" ? 1 : -1);
    }, true);
    return;
  }
  if (!C.searchUrl(location.href)) return;
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== "e6:collect-search" || sender.id !== chrome.runtime.id) return;
    const deadline = Date.now() + 20000;
    function inspect() {
      if (!document.querySelector("#posts")) { reply({ ok: false, error: "pageUnavailable" }); return; }
      if (document.querySelector("#blacklisted-hider")) {
        if (Date.now() >= deadline) { reply({ ok: false, error: "pageBlacklistTimeout" }); return; }
        setTimeout(inspect, 100);
        return;
      }
      try {
        const source = C.searchUrl(location.href);
        const { videos } = C.collect(document, source);
        reply({ ok: true, record: { source, videos, nextPage: C.nextPage(document, source) } });
      } catch { reply({ ok: false, error: "pageUnavailable" }); }
    }
    inspect();
    return true;
  });
  let fingerprint = "";
  let busy = false;
  let pending = false;
  async function snapshot() {
    if (busy) { pending = true; return; }
    busy = true;
    try {
      const { videos, links } = C.collect(document, location.href);
      const nextPage = C.nextPage(document, location.href);
      const signature = JSON.stringify([videos, nextPage]);
      if (signature === fingerprint || !videos.length) return;
      const id = crypto.randomUUID();
      const record = { source: location.href, videos, nextPage, visitedPages: [location.href], createdAt: Date.now() };
      await chrome.storage.local.set({ [C.prefix + id]: record });
      videos.forEach((video, index) => { links[index].href = C.withToken(video.url, id); });
      fingerprint = signature;
    } catch (error) { console.warn(E6I18n.t("snapshotError", settings.language), error); }
    finally { busy = false; if (pending) { pending = false; schedule(); } }
  }
  let timer;
  function schedule() { clearTimeout(timer); timer = setTimeout(snapshot, 100); }
  const gallery = document.querySelector("#posts");
  if (gallery) {
    new MutationObserver(schedule).observe(gallery, {
      subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "data-file-ext"]
    });
    snapshot();
    window.addEventListener("pageshow", schedule);
    // Refresh hidden-item detection immediately before a pointer or keyboard activation.
    gallery.addEventListener("pointerover", schedule, true);
    gallery.addEventListener("focusin", schedule, true);
  }
  // Bound storage use. Active contexts younger than seven days remain available.
  chrome.storage.local.get(null).then(data => {
    const records = Object.entries(data).filter(([name]) => name.startsWith(C.prefix))
      .sort((a, b) => b[1].createdAt - a[1].createdAt);
    const stale = records.filter(([, record], index) => index >= 200 || Date.now() - record.createdAt > 7 * 86400000);
    if (stale.length) return chrome.storage.local.remove(stale.map(([name]) => name));
  }).catch(() => {});
})();
