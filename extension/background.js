/* Temporary top-level tabs let the site apply its own blacklist without embedding it. */
importScripts("core.js");
const jobs = new Map();
const validId = value => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const updateKey = "e6nav:pending-update";
let updating = false;
const supportedPage = value => Boolean(E6Nav.searchUrl(value) || E6Nav.postId(value));

async function applyUpdate(reply) {
  if (updating) { reply({ ok: false }); return; }
  updating = true;
  try {
    // Close only our temporary loaders before recording pages to refresh.
    await Promise.all([...jobs.values()].map(job => finish(job, { ok: false, error: "cancelled" })));
    const tabs = await chrome.tabs.query({ url: ["https://e621.net/posts*", "https://e621.net/favorites*"] });
    const pages = tabs.filter(tab => Number.isInteger(tab.id) && supportedPage(tab.url)).map(tab => ({ id: tab.id, url: tab.url }));
    // session storage is cleared on extension reload, so this one-use handoff must be local.
    await chrome.storage.local.set({ [updateKey]: { createdAt: Date.now(), pages } });
    reply({ ok: true });
    chrome.runtime.reload();
  } catch (error) {
    updating = false;
    await chrome.storage.local.remove(updateKey).catch(() => {});
    console.warn("e621 local update failed:", error);
    reply({ ok: false });
  }
}

async function refreshAfterUpdate() {
  const record = (await chrome.storage.local.get(updateKey))[updateKey];
  if (!record) return;
  // Consume before refreshing: a later worker restart must not refresh the same pages again.
  await chrome.storage.local.remove(updateKey);
  const age = Date.now() - record.createdAt;
  if (!Number.isFinite(age) || age < 0 || age > 120000 || !Array.isArray(record.pages)) return;
  await Promise.allSettled(record.pages.map(async page => {
    if (!Number.isInteger(page?.id) || !supportedPage(page.url)) return;
    const tab = await chrome.tabs.get(page.id);
    if (!supportedPage(tab.url)) return;
    const current = new URL(tab.url);
    const original = new URL(page.url);
    current.hash = ""; original.hash = "";
    // Skip pages closed or navigated elsewhere since the button was pressed.
    if (current.href !== original.href) return;
    await chrome.tabs.reload(page.id);
  }));
}

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === "update") void refreshAfterUpdate().catch(error => console.warn("e621 page refresh failed:", error));
});

async function finish(job, result) {
  if (job.finished) return;
  job.finished = true;
  jobs.delete(job.id);
  clearTimeout(job.timeout);
  clearTimeout(job.retry);
  // A cancellation can arrive while tabs.create is still pending.
  const tabId = job.tabId ?? (await job.creation?.catch(() => null))?.id;
  if (tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => {});
  job.reply(result);
}

async function collect(job) {
  if (job.finished || job.collecting) return;
  job.collecting = true;
  try {
    const result = await chrome.tabs.sendMessage(job.tabId, { type: "e6:collect-search" });
    if (!result?.ok) return finish(job, { ok: false, error: result?.error || "pageUnavailable" });
    const record = result.record;
    if (E6Nav.pageIdentity(record?.source) !== E6Nav.pageIdentity(job.source) ||
        !Array.isArray(record?.videos) || record.videos.some(video => E6Nav.postId(video.url) !== video.id) ||
        (record.nextPage !== null && !E6Nav.searchUrl(record.nextPage))) {
      return finish(job, { ok: false, error: "pageUnavailable" });
    }
    return finish(job, { ok: true, record });
  } catch {
    // document_idle may run just after tabs.onUpdated's complete notification.
    if (!job.finished) job.retry = setTimeout(() => collect(job), 250);
  } finally { job.collecting = false; }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === "e6:apply-update") {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return;
    void applyUpdate(reply);
    return true;
  }
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab || !E6Nav.postId(sender.url)) return;
  if (!validId(message?.id)) return;
  if (message.type === "e6:cancel-search") {
    const job = jobs.get(message.id);
    if (job?.owner === sender.tab.id) void finish(job, { ok: false, error: "cancelled" });
    reply({ ok: true });
    return;
  }
  if (message.type !== "e6:load-search") return;
  if (updating) { reply({ ok: false, error: "pageExtensionError" }); return; }
  const source = E6Nav.searchUrl(message.url);
  if (!source || jobs.has(message.id)) { reply({ ok: false, error: "pageUnavailable" }); return; }
  const job = { id: message.id, owner: sender.tab.id, source, reply, finished: false, collecting: false };
  jobs.set(job.id, job);
  job.timeout = setTimeout(() => void finish(job, { ok: false, error: "pageTimeout" }), 25000);
  void (async () => {
    try {
      // Register the ID before navigating, so even a cached page cannot race the load listener.
      job.creation = chrome.tabs.create({ url: "about:blank", active: false, windowId: sender.tab.windowId, openerTabId: sender.tab.id });
      const tab = await job.creation;
      job.tabId = tab.id;
      if (job.finished) return; // finish() owns cleanup, including a late tabs.create result.
      await chrome.tabs.update(tab.id, { url: source });
    } catch { await finish(job, { ok: false, error: "pageTabError" }); }
  })();
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== "complete") return;
  const job = [...jobs.values()].find(job => job.tabId === tabId);
  if (job) void collect(job);
});
chrome.tabs.onRemoved.addListener(tabId => {
  for (const job of jobs.values()) {
    if (job.owner === tabId || job.tabId === tabId) void finish(job, { ok: false, error: "pageTabClosed" });
  }
});
