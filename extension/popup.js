const field = document.querySelector("#shortcut");
const seekField = document.querySelector("#seek-shortcut");
const previousField = document.querySelector("#previous-shortcut");
const rewindField = document.querySelector("#rewind-shortcut");
const percentField = document.querySelector("#seek-percent");
const rewindPercentField = document.querySelector("#rewind-percent");
const status = document.querySelector("#status");
const modeField = document.querySelector("#end-mode");
const languageField = document.querySelector("#language");
const autoPageField = document.querySelector("#auto-page");
const updateButton = document.querySelector("#apply-update");
let updateStatusKey = null;
let updating = false;
let statusKey = null;
let settings = E6Nav.settings({});
let saving = false;
function setStatus(key) {
  statusKey = key;
  status.textContent = E6I18n.t(key, settings.language);
}
function render() {
  document.documentElement.lang = settings.language === "en" ? "en" : "zh-CN";
  document.title = E6I18n.t("popupTitle", settings.language);
  document.querySelectorAll("[data-i18n]").forEach(node => {
    node.textContent = E6I18n.t(node.dataset.i18n, settings.language);
  });
  field.value = E6Nav.label(settings.nextKey, settings.language);
  seekField.value = E6Nav.label(settings.seekKey, settings.language);
  previousField.value = E6Nav.label(settings.previousKey, settings.language);
  rewindField.value = E6Nav.label(settings.rewindKey, settings.language);
  percentField.value = settings.seekPercent;
  rewindPercentField.value = settings.rewindPercent;
  modeField.value = settings.endMode;
  languageField.value = settings.language;
  autoPageField.checked = settings.autoPage;
  document.querySelector("#current-version").textContent = E6I18n.t("currentVersion", settings.language, { version: chrome.runtime.getManifest().version });
  updateButton.disabled = updating;
  if (updating) updateButton.textContent = E6I18n.t("applyingUpdate", settings.language);
  document.querySelector("#update-status").textContent = updateStatusKey ? E6I18n.t(updateStatusKey, settings.language) : "";
  if (statusKey) setStatus(statusKey);
}
render();
const ready = E6Nav.loadSettings(chrome.storage.local).then(data => {
  settings = data;
  render();
});
async function save(patch) {
  await ready;
  if (saving || updating) return;
  const candidate = { ...settings, ...patch };
  const names = ["nextKey", "previousKey", "seekKey", "rewindKey"];
  if (names.some(name => Object.hasOwn(patch, name)) && names.some((name, index) => names.slice(index + 1).some(other => E6Nav.sameKey(candidate[name], candidate[other])))) {
    setStatus("conflict");
    render();
    return;
  }
  saving = true;
  try {
    await chrome.storage.local.set(patch);
    settings = candidate;
    render();
    setStatus("saved");
  } catch { setStatus("saveError"); }
  finally { saving = false; }
}
function capture(input, name) {
  input.addEventListener("keydown", event => {
    if (event.code === "Tab") return;
    event.preventDefault();
    if (event.isComposing || event.repeat || /^(Control|Alt|Shift|Meta)/.test(event.code)) return;
    if (event.code === "Escape") { input.blur(); return; }
    save({ [name]: { code: event.code, alt: event.altKey, ctrl: event.ctrlKey, shift: event.shiftKey, meta: event.metaKey } });
  });
}
capture(field, "nextKey");
capture(seekField, "seekKey");
capture(previousField, "previousKey");
capture(rewindField, "rewindKey");
function capturePercent(input, name) {
input.addEventListener("change", () => {
  const value = input.valueAsNumber;
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    setStatus("percentError");
    return;
  }
  save({ [name]: value });
});
}
capturePercent(percentField, "seekPercent");
capturePercent(rewindPercentField, "rewindPercent");
modeField.addEventListener("change", () => save({ endMode: modeField.value }));
languageField.addEventListener("change", () => save({ language: languageField.value }));
autoPageField.addEventListener("change", () => save({ autoPage: autoPageField.checked }));
document.querySelector("#reset").addEventListener("click", () => save({
  nextKey: E6Nav.defaultKey, previousKey: E6Nav.defaultPreviousKey,
  seekKey: E6Nav.defaultSeekKey, rewindKey: E6Nav.defaultRewindKey,
  seekPercent: E6Nav.defaultSeekPercent, rewindPercent: E6Nav.defaultSeekPercent
}));
updateButton.addEventListener("click", async () => {
  await ready;
  if (updating || saving) return;
  updating = true;
  updateStatusKey = null;
  render();
  try {
    const result = await chrome.runtime.sendMessage({ type: "e6:apply-update" });
    if (!result?.ok) throw new Error("Update unavailable");
    // The real popup closes when runtime.reload() unloads this extension.
  } catch {
    updating = false;
    updateStatusKey = "updateFailed";
    render();
  }
});
