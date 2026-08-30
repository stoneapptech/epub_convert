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

if (!html.includes('id="fast-mode-switch"') || !html.includes('<span v-if="fastMode">{{ progressLabel }}</span>')) {
    throw new Error("Fast mode must render progress labels without Vue transitions.");
}

if ((html.match(/@click\.stop\.prevent="toggleTooltip"/g) || []).length < 2) {
    throw new Error("Summary tooltip clicks must not toggle the settings accordion.");
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

if (!appSource.includes("event.preventDefault();") || !appSource.includes('addEventListener("pagehide"')) {
    throw new Error("Active conversions must guard beforeunload without cleaning up cancelled navigation.");
}

console.log("Vue template compiled successfully.");
