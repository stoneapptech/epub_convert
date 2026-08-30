import { resolveConfig, resolveMode, supportsJieba, supportsWordConversion } from "./modes.js";
import { t } from "./i18n.js";

if (!globalThis.Vue) {
  throw new Error("Vue failed to load.");
}

const { createApp } = globalThis.Vue;
const THEME_STORAGE_KEY = "epub-convert-theme";
const MIN_STAGE_DISPLAY_MS = 500;
const MIN_CONVERSION_STAGE_DISPLAY_MS = 2000;
const FILENAME_TRANSITION_MS = 240;
const colorScheme = matchMedia("(prefers-color-scheme: dark)");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const ConversionState = Object.freeze({
  EMPTY: "empty",
  SELECTED: "selected",
  CONVERTING: "converting",
  COMPLETE: "complete",
  FAILED: "failed",
});
const ProgressPhaseIcon = Object.freeze({
  "initializing-opencc": "is-microchip-icon",
  "initializing-dictionary": "is-book-open-icon",
  reading: "is-magnifying-glass-icon",
  converting: "is-language-icon",
  building: "is-file-circle-plus-icon",
  compressing: "is-file-zipper-icon",
  complete: "is-circle-check-icon",
});

let selectedFile = null;
let worker = null;
let downloadObjectUrl = null;
let dragDepth = 0;
let snackbarTimer = null;
let progressTimer = null;
let filenameTimer = null;
let progressQueue = [];
let activeProgressPhase = null;
let activePhaseStartedAt = 0;
let activeFilenameProgress = [];
let pendingCompletion = null;
let savedTheme = null;
let systemThemeListener = null;
let beforeUnloadListener = null;

try {
  savedTheme = sessionStorage.getItem(THEME_STORAGE_KEY);
} catch {
  // Storage can be unavailable in private or restricted browser contexts.
}

function applyThemeClass(dark) {
  document.documentElement.classList.toggle("is-dark", dark);
  document.documentElement.classList.toggle("is-light", !dark);
  document.documentElement.dataset.scheme = dark ? "dark" : "light";
}

const initialDarkMode = savedTheme ? savedTheme === "dark" : colorScheme.matches;
applyThemeClass(initialDarkMode);

function terminateWorker() {
  if (worker) worker.terminate();
  worker = null;
}

function clearProgressQueue() {
  if (progressTimer !== null) clearTimeout(progressTimer);
  if (filenameTimer !== null) clearTimeout(filenameTimer);
  progressTimer = null;
  filenameTimer = null;
  progressQueue = [];
  activeProgressPhase = null;
  activePhaseStartedAt = 0;
  activeFilenameProgress = [];
  pendingCompletion = null;
}

function stageDisplayDuration(phase) {
  return phase === "converting"
    ? MIN_CONVERSION_STAGE_DISPLAY_MS
    : MIN_STAGE_DISPLAY_MS;
}

function hasPacedFilenames(phase) {
  return phase === "converting" || phase === "compressing";
}

function filenameProgressLimit(phase) {
  return Math.max(1, Math.floor(stageDisplayDuration(phase) / FILENAME_TRANSITION_MS));
}

function appendFilenameProgress(queue, progress) {
  queue.push(progress);
  if (queue.length <= filenameProgressLimit(progress.phase)) return;

  const lastProgress = queue.at(-1);
  const sampled = queue.filter((_, index) => index % 2 === 0);
  if (sampled.at(-1) !== lastProgress) sampled.push(lastProgress);
  queue.splice(0, queue.length, ...sampled);
}

function filenameTargetTime(progress) {
  if (Number.isFinite(progress.displayPosition)) {
    return activePhaseStartedAt
      + progress.displayPosition * stageDisplayDuration(progress.phase);
  }
  const total = Math.max(1, progress.total || 1);
  const ordinal = progress.phase === "compressing"
    ? Math.max(0, progress.current - 1)
    : Math.max(0, progress.current);
  return activePhaseStartedAt + (ordinal / total) * stageDisplayDuration(progress.phase);
}

function humanFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
}

createApp({
  data() {
    return {
      state: ConversionState.EMPTY,
      hasFile: false,
      isDragover: false,
      fileHeading: t("app.file.select"),
      fileDescription: t("app.file.dropPrompt"),
      fileIcon: "is-book-medical-icon",
      convertToSimplified: false,
      conversionRegion: "tw",
      useWordConversion: false,
      useJieba: false,
      progressDeterminate: false,
      progressPercent: 0,
      progressLabel: t("app.progress.preparing"),
      downloadUrl: "",
      downloadFilename: "",
      darkMode: initialDarkMode,
      snackbarVisible: false,
      snackbarMessage: "",
    };
  },

  computed: {
    isConverting() {
      return this.state === ConversionState.CONVERTING;
    },
    conversionDirection() {
      return this.convertToSimplified ? "t2s" : "s2t";
    },
    conversionRegionLabel() {
      return t(this.convertToSimplified ? "app.region.inputLabel" : "app.region.outputLabel");
    },
    conversionRegionHelp() {
      return t(this.convertToSimplified ? "app.region.inputHelp" : "app.region.outputHelp");
    },
    settingsSummary() {
      const direction = t(this.convertToSimplified ? "app.summary.t2s" : "app.summary.s2t");
      const region = t(`app.summary.region.${this.conversionRegion}`);
      const conversion = t(this.useWordConversion ? "app.summary.words" : "app.summary.characters");
      return [direction, region, conversion, this.useJieba ? t("app.summary.segmentation") : null].filter(Boolean);
    },
    mode() {
      return resolveMode(this.conversionDirection, this.conversionRegion, this.useWordConversion);
    },
    wordConversionSupported() {
      return supportsWordConversion(this.conversionDirection, this.conversionRegion);
    },
    wordConversionHelp() {
      if (!this.wordConversionSupported) return t("app.words.unavailable");
      if (this.convertToSimplified) {
        return t(this.conversionRegion === "tw"
          ? "app.words.twToSimplifiedHelp"
          : "app.words.hkToSimplifiedHelp");
      }
      return t(this.conversionRegion === "tw"
        ? "app.words.toTaiwanHelp"
        : "app.words.toHongKongHelp");
    },
    wordConversionLabel() {
      if (this.convertToSimplified) return t("app.words.toChina");
      if (this.conversionRegion === "tw") return t("app.words.toTaiwan");
      if (this.conversionRegion === "hk") return t("app.words.toHongKong");
      return t("app.words.generic");
    },
    jiebaSupported() {
      return supportsJieba(this.mode);
    },
    jiebaHelp() {
      return t(this.jiebaSupported ? "app.jieba.available" : "app.jieba.unavailable");
    },
    progressClass() {
      return this.progressDeterminate ? "is-processing" : "is-indeterminate";
    },
    themeLabel() {
      return t(this.darkMode ? "app.theme.toLight" : "app.theme.toDark");
    },
    closeButtonLabel() {
      return t(this.isConverting ? "app.action.cancel" : "app.action.clearFile");
    },
  },

  watch: {
    wordConversionSupported(supported) {
      if (!supported) this.useWordConversion = false;
    },
    mode() {
      if (!this.jiebaSupported) this.useJieba = false;
    },
  },

  mounted() {
    systemThemeListener = (event) => {
      if (!savedTheme) this.applyTheme(event.matches);
    };
    colorScheme.addEventListener?.("change", systemThemeListener);

    beforeUnloadListener = () => this.cleanup();
    window.addEventListener("beforeunload", beforeUnloadListener);
  },

  beforeUnmount() {
    colorScheme.removeEventListener?.("change", systemThemeListener);
    window.removeEventListener("beforeunload", beforeUnloadListener);
    this.cleanup();
  },

    methods: {
        toggleTooltip(event) {
            const target = event.currentTarget;
            if (target.hasAttribute("aria-describedby")) {
                target.blur();
                return;
            }
            target.focus({ preventScroll: true });
        },

        createWorker() {
      worker = new Worker(new URL("./convert-worker.js", import.meta.url), { type: "module" });
      worker.addEventListener("message", this.handleWorkerMessage);
      worker.addEventListener("error", (event) => {
        this.failConversion(
          t("app.error.unknown"),
          event.error || event,
        );
      });
    },

    cleanup() {
      terminateWorker();
      clearProgressQueue();
      this.revokeDownload();
      clearTimeout(snackbarTimer);
    },

    revokeDownload() {
      if (downloadObjectUrl) URL.revokeObjectURL(downloadObjectUrl);
      downloadObjectUrl = null;
      this.downloadUrl = "";
      this.downloadFilename = "";
    },

    showSnackbar(message) {
      clearTimeout(snackbarTimer);
      this.snackbarMessage = message;
      this.snackbarVisible = true;
      snackbarTimer = setTimeout(() => this.hideSnackbar(), 6000);
    },

    hideSnackbar() {
      clearTimeout(snackbarTimer);
      this.snackbarVisible = false;
    },

    resetProgress() {
      this.progressDeterminate = false;
      this.progressPercent = 0;
      this.progressLabel = t("app.progress.preparing");
    },

    selectFile(file, syncInput = false) {
      if (!file || !/\.epub$/i.test(file.name)) {
        this.$refs.fileInput.value = "";
        this.showSnackbar(t("app.file.invalidExtension"));
        return;
      }

      this.revokeDownload();
      selectedFile = file;
      this.hasFile = true;
      this.fileHeading = file.name;
      this.fileDescription = t("app.file.size", { size: humanFileSize(file.size) });
      this.fileIcon = "is-book-open-icon";
      this.state = ConversionState.SELECTED;

      if (syncInput) {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        this.$refs.fileInput.files = transfer.files;
      }
    },

    resetSelection() {
      terminateWorker();
      clearProgressQueue();
      this.revokeDownload();
      selectedFile = null;
      this.$refs.fileInput.value = "";
      this.state = ConversionState.EMPTY;
      this.hasFile = false;
      this.fileHeading = t("app.file.select");
      this.fileDescription = t("app.file.dropPrompt");
      this.fileIcon = "is-book-open-icon";
      this.resetProgress();
    },

    openFilePicker(event) {
      if (!event.target.matches("#file-panel, #file-panel > *")) return;
      if (!this.isConverting) this.$refs.fileInput.click();
    },

    onFileChange(event) {
      const files = event.target.files;
      if (files.length === 1) this.selectFile(files[0]);
      else if (!files.length) this.resetSelection();
    },

    async startConversion() {
      if (!selectedFile) return;
      clearProgressQueue();
      this.revokeDownload();
      this.resetProgress();
      this.state = ConversionState.CONVERTING;
      this.fileIcon = "is-language-icon";

      try {
        const bytes = await selectedFile.arrayBuffer();
        if (!worker) this.createWorker();
        const config = resolveConfig(this.mode, this.useJieba);
        worker.postMessage(
          { type: "convert", bytes, filename: selectedFile.name, config },
          [bytes],
        );
      } catch (error) {
        this.failConversion(error.message || t("app.error.readFile"), error);
      }
    },

    updateProgress(progress) {
      this.progressDeterminate = Number.isFinite(progress.percent)
        && !progress.phase.startsWith("initializing");
      if (this.progressDeterminate) {
        this.progressPercent = Math.max(0, Math.min(100, progress.percent));
      }
      this.progressLabel = progress.label || t("app.progress.converting");
      this.fileIcon = ProgressPhaseIcon[progress.phase] || "is-gears-icon";
    },

    queueProgress(progress) {
      if (reducedMotion.matches) {
        this.updateProgress(progress);
        return;
      }

      if (progress.phase === activeProgressPhase) {
        if (hasPacedFilenames(progress.phase)) {
          appendFilenameProgress(activeFilenameProgress, progress);
          this.scheduleFilenameProgress();
        } else {
          this.updateProgress(progress);
        }
        return;
      }

      const lastIndex = progressQueue.length - 1;
      if (progressQueue[lastIndex]?.phase === progress.phase) {
        if (hasPacedFilenames(progress.phase)) {
          appendFilenameProgress(progressQueue[lastIndex].updates, progress);
        } else {
          progressQueue[lastIndex].updates = [progress];
        }
      } else {
        progressQueue.push({ phase: progress.phase, updates: [progress] });
      }
      this.scheduleProgressAdvance();
    },

    scheduleFilenameProgress() {
      if (filenameTimer !== null || !activeFilenameProgress.length) return;
      const delay = Math.max(0, filenameTargetTime(activeFilenameProgress[0]) - performance.now());
      filenameTimer = setTimeout(() => {
        filenameTimer = null;
        this.showNextFilename();
      }, delay);
    },

    showNextFilename() {
      const progress = activeFilenameProgress.shift();
      if (!progress || !this.isConverting || progress.phase !== activeProgressPhase) return;
      this.updateProgress(progress);
      this.scheduleFilenameProgress();
    },

    queueCompletion(message) {
      if (reducedMotion.matches) {
        this.finishConversion(message);
        return;
      }
      pendingCompletion = message;
      this.scheduleProgressAdvance();
    },

    scheduleProgressAdvance() {
      if (progressTimer !== null) return;
      if (!progressQueue.length && !pendingCompletion) return;

      const elapsed = activeProgressPhase === null
        ? MIN_STAGE_DISPLAY_MS
        : performance.now() - activePhaseStartedAt;
      const minimumDisplay = stageDisplayDuration(activeProgressPhase);
      const delay = Math.max(0, minimumDisplay - elapsed);
      if (delay === 0) {
        this.advanceProgressQueue();
        return;
      }

      progressTimer = setTimeout(() => {
        progressTimer = null;
        this.advanceProgressQueue();
      }, delay);
    },

    advanceProgressQueue() {
      if (!this.isConverting) {
        clearProgressQueue();
        return;
      }

      if (progressQueue.length) {
        const group = progressQueue.shift();
        const progress = group.updates.shift();
        if (filenameTimer !== null) clearTimeout(filenameTimer);
        filenameTimer = null;
        activeFilenameProgress = group.updates.map((update, index, updates) => ({
          ...update,
          displayPosition: (index + 1) / (updates.length + 1),
        }));
        activeProgressPhase = progress.phase;
        activePhaseStartedAt = performance.now();
        this.updateProgress(progress);
        this.scheduleFilenameProgress();
        this.scheduleProgressAdvance();
        return;
      }

      if (pendingCompletion) {
        const message = pendingCompletion;
        clearProgressQueue();
        this.finishConversion(message);
      }
    },

    finishConversion(message) {
      const blob = new Blob([message.bytes], { type: "application/epub+zip" });
      downloadObjectUrl = URL.createObjectURL(blob);
      this.downloadUrl = downloadObjectUrl;
      this.downloadFilename = message.filename;
      this.fileHeading = t("app.result.complete");
      this.fileDescription = message.filename;
      this.fileIcon = "is-circle-check-icon is-positive";
      this.state = ConversionState.COMPLETE;
    },

    failConversion(message, error = null) {
      console.error("[EPUB converter] Conversion failed", {
        error: error || message,
        filename: selectedFile?.name || null,
        mode: this.mode,
        useJieba: this.useJieba,
        state: this.state,
      });
      clearProgressQueue();
      terminateWorker();
      this.fileHeading = t("app.result.failed");
      this.fileDescription = message;
      this.fileIcon = "is-circle-exclamation-icon is-negative";
      this.state = ConversionState.FAILED;
      this.showSnackbar(message);
    },

    handleWorkerMessage(event) {
      if (event.data?.type === "progress") this.queueProgress(event.data);
      if (event.data?.type === "complete") this.queueCompletion(event.data);
      if (event.data?.type === "error") {
        const detail = event.data.error.entryName ? `（${event.data.error.entryName}）` : "";
        this.failConversion(`${event.data.error.message}${detail}`, event.data.error);
      }
    },

    cancelConversion() {
      if (!this.isConverting || !selectedFile) return;
      clearProgressQueue();
      terminateWorker();
      this.fileHeading = selectedFile.name;
      this.fileDescription = t("app.file.size", { size: humanFileSize(selectedFile.size) });
      this.fileIcon = "is-book-open-reader-icon";
      this.state = ConversionState.SELECTED;
      this.showSnackbar(t("app.result.cancelled"));
    },

    closeFilePanel() {
      if (this.isConverting) this.cancelConversion();
      else this.resetSelection();
    },

    beforeUnloadMessage() {
      if (this.isConverting) return t("app.beforeUnload");
      return null;
    },

    applyTheme(dark, persist = false) {
      this.darkMode = dark;
      applyThemeClass(dark);

      if (persist) {
        savedTheme = dark ? "dark" : "light";
        try {
          sessionStorage.setItem(THEME_STORAGE_KEY, savedTheme);
        } catch {
          // The theme still works for this page when storage is unavailable.
        }
      }
    },

    saveTheme() {
      this.applyTheme(this.darkMode, true);
    },

    onDragEnter() {
      if (this.isConverting) return;
      dragDepth += 1;
      this.isDragover = true;
    },

    onDragLeave() {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) this.isDragover = false;
    },

    onDrop(event) {
      dragDepth = 0;
      this.isDragover = false;
      if (this.isConverting) return;

      const files = event.dataTransfer?.files;
      if (!files || files.length !== 1) {
        this.showSnackbar(t("app.file.singleOnly"));
        return;
      }
      this.selectFile(files[0], true);
    },
  },
}).mount("#app");
