const { readFileSync } = require("node:fs");
const { compile } = require("@vue/compiler-dom");

const html = readFileSync("index.html", "utf8").replaceAll("\r\n", "\n");
const appSource = readFileSync("static/app.js", "utf8");

const mainHtml = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
if (/\p{Script=Han}/u.test(mainHtml)) {
    throw new Error("User-facing Chinese strings in <main> must be stored in the locale catalog.");
}
const opening = '<div id="app" v-cloak>';
const start = html.indexOf(opening);
const bodyEnd = html.lastIndexOf("</body>");
const end = html.lastIndexOf("</div>", bodyEnd);

if (start < 0 || bodyEnd < 0 || end < start) {
    throw new Error("Could not isolate the #app template in index.html.");
}

compile(html.slice(start + opening.length, end), {
    onError(error) {
        throw error;
    },
});

if (!html.includes('id="epub-file"') || !html.includes("multiple hidden")) {
    throw new Error("The EPUB file input must support multiple files.");
}

if (!html.includes('id="auto-download-switch"')) {
    throw new Error("The auto-download switch is missing.");
}

if (!html.includes('id="download-all-button"')
    || !html.includes('v-if="showDownloadAll"')
    || !html.includes('@click="downloadAllSuccessful"')
    || !appSource.includes("for (const download of this.downloads) this.triggerDownload(download)")) {
    throw new Error("Completed multi-file batches must offer downloading all successful EPUBs.");
}

if (!html.includes('id="fast-mode-switch"') || !html.includes('<span v-if="fastMode">{{ progressLabel }}</span>')) {
    throw new Error("Fast mode must render progress labels without Vue transitions.");
}

if (!html.includes('<dialog ref="customDictionaryDialog" class="ts-modal is-large"')
    || !html.includes('id="custom-dictionary-enabled" v-model="dictionaryDraftEnabled"')
    || !html.includes('id="saved-dictionary-select" v-model="selectedSavedDictionary" @change="loadSavedDictionary"')
    || !html.includes('id="custom-dictionary-entries"')) {
    throw new Error("The custom dictionary editor must use native Tocas form and modal components.");
}

if (html.includes('@change="toggleCustomDictionary"')
    || appSource.includes("toggleCustomDictionary()")) {
    throw new Error("The custom dictionary switch must remain a draft until Apply is used.");
}

if (!html.includes('@click="applyCustomDictionary"')) {
    throw new Error("Custom dictionary drafts must be applicable without saving them.");
}

if ((html.match(/@click="saveCustomDictionary"/g) || []).length !== 1
    || !html.includes(':disabled="!dictionaryChanged" @click="saveCustomDictionary"')) {
    throw new Error("Selecting a dictionary must load it automatically, with one adjacent save action.");
}

if (!appSource.includes("localStorage.setItem(")
    || !appSource.includes("parseDictionaryLibrary(await file.text())")
    || !appSource.includes('filename: "opencc-custom-dictionaries.json"')) {
    throw new Error("Custom dictionaries must support local persistence and JSON import/export.");
}

const tooltipCount = (html.match(/:data-tooltip=/g) || []).length;
if (!tooltipCount
    || (html.match(/data-trigger="hover focus"/g) || []).length !== tooltipCount
    || (html.match(/@click\.stop\.prevent="toggleTooltip"/g) || []).length !== tooltipCount
    || (html.match(/@keydown\.enter\.prevent="toggleTooltip"/g) || []).length !== tooltipCount
    || (html.match(/@keydown\.space\.prevent="toggleTooltip"/g) || []).length !== tooltipCount) {
    throw new Error("Every tooltip must support isolated mouse, touch, and keyboard activation.");
}

if (!html.includes("canEditSelection && selectedBooks.length > 1") || !html.includes("class=\"ts-chip is-outlined\"") || !html.includes("removeSelectedFile(index)")) {
    throw new Error("Selected EPUBs must use removable Tocas chips.");
}

const settingsSummaryStart = html.indexOf("<summary>", html.indexOf('id="settings-details"'));
const settingsSummaryEnd = html.indexOf("</summary>", settingsSummaryStart);
const autoDownloadSwitch = html.indexOf('id="auto-download-switch"');
if (autoDownloadSwitch < settingsSummaryStart || autoDownloadSwitch > settingsSummaryEnd) {
    throw new Error("The auto-download switch must remain inside the settings summary.");
}

if (!/const MAX_BATCH_FILES = [1-9]\d*;/.test(appSource) || !appSource.includes("autoDownload: false")) {
    throw new Error("The batch limit or default auto-download state is incorrect.");
}

if (!appSource.includes("this.failures.push({ filename: failedFile.name, stage })")
    || appSource.includes("this.failures.push({ filename: failedFile.name, message })")) {
    throw new Error("Visible batch failures must show only their stage; diagnostics belong in the console.");
}

if (!appSource.includes("event.preventDefault();") || !appSource.includes('addEventListener("pagehide"')) {
    throw new Error("Active conversions must guard beforeunload without cleaning up cancelled navigation.");
}

if (!html.includes('ref="snackbarContainer"')
    || !html.includes('class="snackbar-container"')
    || !html.includes('popover="manual"')
    || !appSource.includes("container.showPopover()")
    || !appSource.includes("container.hidePopover()")
    || !appSource.includes("if (this.snackbarVisible) this.$nextTick(() => this.raiseSnackbar())")) {
    throw new Error("Snackbars must use the browser top layer so they remain visible above dialogs.");
}

if (!html.includes("@pointerdown.stop")
    || !html.includes("@mousedown.stop")
    || !html.includes("@click.stop")) {
    throw new Error("Snackbar interaction must not reach the dialog backdrop handler.");
}

if (!html.includes('id="snackbar-close"')
    || !html.includes('@pointerup.stop.prevent="hideSnackbar"')
    || !html.includes('@click.stop.prevent="hideSnackbar"')) {
    throw new Error("The snackbar close control must handle pointer and keyboard activation directly.");
}

const loadSavedDictionary = appSource.slice(
    appSource.indexOf("loadSavedDictionary()"),
    appSource.indexOf("deleteSavedDictionary()"),
);
if (loadSavedDictionary.includes("commitCustomDictionary")
    || !loadSavedDictionary.includes("this.dictionaryDraftEnabled = true")) {
    throw new Error("Loading a saved dictionary must enable its draft without applying it.");
}

console.log("Vue template compiled successfully.");
