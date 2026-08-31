import { resolveConfig, resolveMode, supportsJieba, supportsWordConversion } from "./modes.js";
import { t } from "./i18n.js";
import {
  CustomDictionaryError,
  mergeDictionaryLibraries,
  parseCustomDictionary,
  parseDictionaryLibrary,
  serializeDictionaryLibrary,
} from "./custom-dictionaries.js";

if (!globalThis.Vue) {
  throw new Error("Vue failed to load.");
}

const { createApp } = globalThis.Vue;
const THEME_STORAGE_KEY = "epub-convert-theme";
const CUSTOM_DICTIONARY_STORAGE_KEY = "epub-convert-custom-dictionaries";
const MIN_STAGE_DISPLAY_MS = 500;
const MIN_CONVERSION_STAGE_DISPLAY_MS = 2000;
const FILENAME_TRANSITION_MS = 240;
const MAX_BATCH_FILES = 25;
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
  "initializing-custom-dictionary": "is-spell-check-icon",
  reading: "is-magnifying-glass-icon",
  converting: "is-language-icon",
  building: "is-file-circle-plus-icon",
  compressing: "is-file-zipper-icon",
  complete: "is-circle-check-icon",
});
const FailurePhaseLocaleKey = Object.freeze({
  initializing: "app.failureStage.opencc",
  "initializing-opencc": "app.failureStage.opencc",
  "initializing-dictionary": "app.failureStage.dictionary",
  "initializing-custom-dictionary": "app.failureStage.customDictionary",
  "reading-file": "app.failureStage.fileReading",
  reading: "app.failureStage.epubReading",
  converting: "app.failureStage.converting",
  building: "app.failureStage.building",
  compressing: "app.failureStage.compressing",
  complete: "app.failureStage.finishing",
});

let selectedFiles = [];
let currentFile = null;
let batchIndex = 0;
let batchConfig = null;
let batchCustomDictionary = null;
let activeCustomDictionaryEntries = [];
let customDictionaryRevision = 0;
let nextSelectedFileId = 0;
let worker = null;
const downloadObjectUrls = new Set();
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
let pageHideListener = null;

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
      t,
      state: ConversionState.EMPTY,
      hasFile: false,
      isDragover: false,
      fileHeading: t("app.file.select"),
      fileDescription: t("app.file.dropPrompt"),
      fileIcon: "is-book-medical-icon",
      convertToSimplified: false,
      conversionRegion: "tw",
      useWordConversion: true,
      useJieba: false,
      autoDownload: false,
      fastMode: false,
      customDictionaryEnabled: false,
      customDictionaryName: "",
      customDictionaryEntryCount: 0,
      customDictionaryText: "",
      dictionaryDraftEnabled: false,
      dictionaryDraftName: "",
      dictionaryDraftText: "",
      selectedSavedDictionary: "",
      savedDictionaries: [],
      selectedBooks: [],
      progressDeterminate: false,
      progressPercent: 0,
      progressLabel: t("app.progress.preparing"),
      downloads: [],
      failures: [],
      darkMode: initialDarkMode,
      snackbarVisible: false,
      snackbarMessage: "",
    };
  },

  computed: {
    isConverting() {
      return this.state === ConversionState.CONVERTING;
    },
    canEditSelection() {
      return this.hasFile && (
        this.state === ConversionState.SELECTED ||
        this.state === ConversionState.FAILED
      );
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
      return [
        direction,
        region,
        conversion,
        this.useJieba ? t("app.summary.segmentation") : null,
        this.customDictionaryEnabled ? t("app.summary.customDictionary") : null,
      ].filter(Boolean);
    },
    customDictionaryStatus() {
      if (!this.customDictionaryEnabled) return t("app.dictionary.statusDisabled");
      return t("app.dictionary.statusEnabled", {
        name: this.customDictionaryName || t("app.dictionary.unnamed"),
        count: this.customDictionaryEntryCount,
      });
    },
    dictionaryChanged() {
      const saved = this.savedDictionaries.find(
        ({ name }) => name === this.selectedSavedDictionary,
      );
      const name = this.dictionaryDraftName.trim();
      if (!saved) return Boolean(name || this.dictionaryDraftText);
      return name !== saved.name || this.dictionaryDraftText !== saved.text;
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

    beforeUnloadListener = (event) => {
      const message = this.beforeUnloadMessage();
      if (!message) return;
      event.preventDefault();
      event.returnValue = message;
    };
    pageHideListener = () => this.cleanup();
    window.addEventListener("beforeunload", beforeUnloadListener);
    window.addEventListener("pagehide", pageHideListener);
    this.loadDictionaryLibrary();
  },

  beforeUnmount() {
    colorScheme.removeEventListener?.("change", systemThemeListener);
    window.removeEventListener("beforeunload", beforeUnloadListener);
    window.removeEventListener("pagehide", pageHideListener);
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
        this.failCurrentFile(
          t("app.error.unknown"),
          event.error || event,
          true,
        );
      });
    },

    cleanup() {
      terminateWorker();
      clearProgressQueue();
      this.revokeDownloads();
      clearTimeout(snackbarTimer);
    },

    revokeDownloads() {
      for (const url of downloadObjectUrls) URL.revokeObjectURL(url);
      downloadObjectUrls.clear();
      this.downloads = [];
    },

    showSnackbar(message) {
      clearTimeout(snackbarTimer);
      this.snackbarMessage = message;
      this.snackbarVisible = true;
      this.$nextTick(() => this.raiseSnackbar());
      snackbarTimer = setTimeout(() => this.hideSnackbar(), 6000);
    },

    raiseSnackbar() {
      const container = this.$refs.snackbarContainer;
      if (typeof container?.showPopover !== "function") return;
      if (container.matches(":popover-open")) container.hidePopover();
      container.showPopover();
    },

    hideSnackbar() {
      clearTimeout(snackbarTimer);
      const container = this.$refs.snackbarContainer;
      if (typeof container?.hidePopover === "function"
        && container.matches(":popover-open")) {
        container.hidePopover();
      }
      this.snackbarVisible = false;
    },

    dictionaryErrorMessage(error) {
      const code = error instanceof CustomDictionaryError ? error.code : "invalid-library";
      const keyByCode = {
        "invalid-text": "app.dictionary.error.invalidText",
        "too-large": "app.dictionary.error.tooLarge",
        "invalid-entry": "app.dictionary.error.invalidEntry",
        "duplicate-source": "app.dictionary.error.duplicateSource",
        "too-many-entries": "app.dictionary.error.tooManyEntries",
        "invalid-library": "app.dictionary.error.invalidLibrary",
        "invalid-name": "app.dictionary.error.invalidName",
        "too-many-dictionaries": "app.dictionary.error.tooManyDictionaries",
        empty: "app.dictionary.error.empty",
      };
      return t(keyByCode[code] || "app.dictionary.error.invalidLibrary", {
        line: error?.line || 0,
      });
    },

    loadDictionaryLibrary() {
      try {
        const saved = localStorage.getItem(CUSTOM_DICTIONARY_STORAGE_KEY);
        this.savedDictionaries = saved ? parseDictionaryLibrary(saved) : [];
      } catch (error) {
        console.error("[EPUB converter] Could not load custom dictionaries", error);
        this.savedDictionaries = [];
        this.showSnackbar(this.dictionaryErrorMessage(error));
      }
    },

    persistDictionaryLibrary(dictionaries) {
      try {
        localStorage.setItem(
          CUSTOM_DICTIONARY_STORAGE_KEY,
          serializeDictionaryLibrary(dictionaries),
        );
        this.savedDictionaries = dictionaries;
        return true;
      } catch (error) {
        console.error("[EPUB converter] Could not save custom dictionaries", error);
        this.showSnackbar(error instanceof CustomDictionaryError
          ? this.dictionaryErrorMessage(error)
          : t("app.dictionary.error.storage"));
        return false;
      }
    },

    openCustomDictionaryDialog() {
      this.dictionaryDraftEnabled = this.customDictionaryEnabled;
      this.dictionaryDraftName = this.customDictionaryName;
      this.dictionaryDraftText = this.customDictionaryText;
      this.selectedSavedDictionary = this.savedDictionaries.some(
        ({ name }) => name === this.customDictionaryName,
      ) ? this.customDictionaryName : "";
      this.$refs.customDictionaryDialog.showModal();
      if (this.snackbarVisible) this.$nextTick(() => this.raiseSnackbar());
    },

    closeCustomDictionaryDialog() {
      this.$refs.customDictionaryDialog.close();
    },

    commitCustomDictionary(enabled) {
      const entries = enabled ? parseCustomDictionary(this.dictionaryDraftText) : [];
      if (enabled && !entries.length) throw new CustomDictionaryError("empty");
      this.customDictionaryEnabled = enabled;
      this.customDictionaryName = this.dictionaryDraftName.trim();
      this.customDictionaryText = this.dictionaryDraftText;
      this.customDictionaryEntryCount = entries.length;
      activeCustomDictionaryEntries = entries.map((entry) => [...entry]);
      customDictionaryRevision += 1;
    },

    applyCustomDictionary() {
      try {
        this.commitCustomDictionary(this.dictionaryDraftEnabled);
        this.closeCustomDictionaryDialog();
        this.showSnackbar(t(this.customDictionaryEnabled
          ? "app.dictionary.applied"
          : "app.dictionary.disabled"));
      } catch (error) {
        this.showSnackbar(this.dictionaryErrorMessage(error));
      }
    },

    saveCustomDictionary() {
      try {
        const name = this.dictionaryDraftName.trim();
        if (!name || name.length > 100) throw new CustomDictionaryError("invalid-name");
        const entries = parseCustomDictionary(this.dictionaryDraftText);
        if (!entries.length) throw new CustomDictionaryError("empty");

        const dictionaries = this.savedDictionaries.map((dictionary) => ({ ...dictionary }));
        const existingIndex = dictionaries.findIndex((dictionary) => dictionary.name === name);
        const record = { name, text: this.dictionaryDraftText };
        if (existingIndex >= 0) dictionaries.splice(existingIndex, 1, record);
        else dictionaries.push(record);
        if (!this.persistDictionaryLibrary(dictionaries)) return;
        this.dictionaryDraftName = name;
        this.selectedSavedDictionary = name;
        this.showSnackbar(t("app.dictionary.saved", { name }));
      } catch (error) {
        this.showSnackbar(this.dictionaryErrorMessage(error));
      }
    },

    loadSavedDictionary() {
      const dictionary = this.savedDictionaries.find(
        ({ name }) => name === this.selectedSavedDictionary,
      );
      if (!dictionary) return;
      this.dictionaryDraftName = dictionary.name;
      this.dictionaryDraftText = dictionary.text;
      this.dictionaryDraftEnabled = true;
      this.showSnackbar(t("app.dictionary.loaded", { name: dictionary.name }));
    },

    deleteSavedDictionary() {
      if (!this.selectedSavedDictionary) return;
      const name = this.selectedSavedDictionary;
      const dictionaries = this.savedDictionaries.filter(
        (dictionary) => dictionary.name !== name,
      );
      if (!this.persistDictionaryLibrary(dictionaries)) return;
      this.selectedSavedDictionary = "";
      this.showSnackbar(t("app.dictionary.deleted", { name }));
    },

    openDictionaryImport() {
      this.$refs.dictionaryImportInput.click();
    },

    async importDictionaries(event) {
      const [file] = event.target.files;
      if (!file) return;
      try {
        const imported = parseDictionaryLibrary(await file.text());
        const dictionaries = mergeDictionaryLibraries(this.savedDictionaries, imported);
        if (!this.persistDictionaryLibrary(dictionaries)) return;
        this.showSnackbar(t("app.dictionary.imported", { count: imported.length }));
      } catch (error) {
        this.showSnackbar(this.dictionaryErrorMessage(error));
      } finally {
        event.target.value = "";
      }
    },

    exportDictionaries() {
      try {
        if (!this.savedDictionaries.length) throw new CustomDictionaryError("empty-library");
        const blob = new Blob(
          [serializeDictionaryLibrary(this.savedDictionaries)],
          { type: "application/json" },
        );
        const url = URL.createObjectURL(blob);
        this.triggerDownload({ url, filename: "opencc-custom-dictionaries.json" });
        setTimeout(() => URL.revokeObjectURL(url), 0);
        this.showSnackbar(t("app.dictionary.exported", {
          count: this.savedDictionaries.length,
        }));
      } catch (error) {
        if (error?.code === "empty-library") {
          this.showSnackbar(t("app.dictionary.error.emptyLibrary"));
          return;
        }
        this.showSnackbar(this.dictionaryErrorMessage(error));
      }
    },

    resetProgress() {
      this.progressDeterminate = false;
      this.progressPercent = 0;
      this.progressLabel = t("app.progress.preparing");
    },

    selectFiles(fileList, syncInput = false) {
      const files = Array.from(fileList || []);
      const epubFiles = files.filter((file) => /\.epub$/i.test(file.name));
      const validFiles = epubFiles.slice(0, MAX_BATCH_FILES);
      const invalidCount = files.length - epubFiles.length;
      const overflowCount = epubFiles.length - validFiles.length;
      if (!validFiles.length) {
        this.$refs.fileInput.value = "";
        this.showSnackbar(t("app.file.invalidExtension"));
        return;
      }

      this.revokeDownloads();
      this.failures = [];
      selectedFiles = validFiles;
      this.selectedBooks = validFiles.map((file) => ({
        id: ++nextSelectedFileId,
        name: file.name,
      }));
      this.hasFile = true;
      this.fileIcon = "is-book-open-icon";
      this.state = ConversionState.SELECTED;
      this.updateSelectionSummary();

      if (overflowCount) {
        this.showSnackbar(t("app.file.tooMany", {
          limit: MAX_BATCH_FILES,
          count: overflowCount,
        }));
      } else if (invalidCount) {
        this.showSnackbar(t("app.file.invalidFiles", { count: invalidCount }));
      }

      if (syncInput) {
        this.syncFileInput();
      }
    },

    syncFileInput() {
      const transfer = new DataTransfer();
      for (const file of selectedFiles) transfer.items.add(file);
      this.$refs.fileInput.files = transfer.files;
    },

    removeSelectedFile(index) {
      if (!this.canEditSelection || index < 0 || index >= selectedFiles.length) return;
      selectedFiles.splice(index, 1);
      this.selectedBooks.splice(index, 1);
      this.failures = [];

      if (!selectedFiles.length) {
        this.resetSelection();
        return;
      }

      this.syncFileInput();
      this.state = ConversionState.SELECTED;
      this.fileIcon = "is-book-open-icon";
      this.updateSelectionSummary();
    },

    updateSelectionSummary() {
      if (selectedFiles.length === 1) {
        this.fileHeading = selectedFiles[0].name;
        this.fileDescription = t("app.file.size", { size: humanFileSize(selectedFiles[0].size) });
        return;
      }
      const totalSize = selectedFiles.reduce((sum, file) => sum + file.size, 0);
      this.fileHeading = t("app.file.selectedMany", { count: selectedFiles.length });
      this.fileDescription = t("app.file.totalSize", { size: humanFileSize(totalSize) });
    },

    resetSelection() {
      terminateWorker();
      clearProgressQueue();
      this.revokeDownloads();
      selectedFiles = [];
      this.selectedBooks = [];
      currentFile = null;
      batchIndex = 0;
      batchConfig = null;
      batchCustomDictionary = null;
      this.failures = [];
      this.$refs.fileInput.value = "";
      this.state = ConversionState.EMPTY;
      this.hasFile = false;
      this.fileHeading = t("app.file.select");
      this.fileDescription = t("app.file.dropPrompt");
      this.fileIcon = "is-book-medical-icon";
      this.resetProgress();
    },

    openFilePicker(event) {
      if (!event.target.matches("#file-panel, #file-panel > *")) return;
      if (!this.isConverting) this.$refs.fileInput.click();
    },

    onFileChange(event) {
      const files = event.target.files;
      if (files.length) this.selectFiles(files, true);
      else if (!files.length) this.resetSelection();
    },

    startConversion() {
      if (!selectedFiles.length) return;
      clearProgressQueue();
      this.revokeDownloads();
      this.failures = [];
      this.resetProgress();
      this.state = ConversionState.CONVERTING;
      this.fileIcon = "is-language-icon";
      batchIndex = 0;
      batchConfig = resolveConfig(this.mode, this.useJieba);
      batchCustomDictionary = this.customDictionaryEnabled && activeCustomDictionaryEntries.length
        ? {
          id: customDictionaryRevision,
          entries: activeCustomDictionaryEntries,
        }
        : null;
      this.convertNextFile();
    },

    async convertNextFile() {
      if (!this.isConverting) return;
      if (batchIndex >= selectedFiles.length) {
        this.finishBatch();
        return;
      }

      clearProgressQueue();
      this.resetProgress();
      currentFile = selectedFiles[batchIndex];
      this.fileHeading = currentFile.name;
      this.fileDescription = selectedFiles.length > 1
        ? t("app.batch.progress", {
          current: batchIndex + 1,
          total: selectedFiles.length,
        })
        : t("app.file.size", { size: humanFileSize(currentFile.size) });
      this.fileIcon = "is-language-icon";

      try {
        const bytes = await currentFile.arrayBuffer();
        if (!worker) this.createWorker();
        worker.postMessage(
          {
            type: "convert",
            bytes,
            filename: currentFile.name,
            config: batchConfig,
            customDictionary: batchCustomDictionary,
          },
          [bytes],
        );
      } catch (error) {
        this.failCurrentFile(error.message || t("app.error.readFile"), error, false, "reading-file");
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
      if (reducedMotion.matches || this.fastMode) {
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
      if (reducedMotion.matches || this.fastMode) {
        this.finishCurrentFile(message);
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
        this.finishCurrentFile(message);
      }
    },

    finishCurrentFile(message) {
      if (!this.isConverting || !currentFile) return;
      const blob = new Blob([message.bytes], { type: "application/epub+zip" });
      const url = URL.createObjectURL(blob);
      downloadObjectUrls.add(url);
      const download = { url, filename: message.filename };
      this.downloads.push(download);
      if (this.autoDownload) this.triggerDownload(download);

      currentFile = null;
      batchIndex += 1;
      this.convertNextFile();
    },

    triggerDownload(download) {
      const link = document.createElement("a");
      link.href = download.url;
      link.download = download.filename;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
    },

    failCurrentFile(message, error = null, forceWorkerReset = false, phase = null) {
      if (!this.isConverting || !currentFile) return;
      const failedFile = currentFile;
      const failurePhase = phase || error?.phase || activeProgressPhase;
      const stage = t(FailurePhaseLocaleKey[failurePhase] || "app.failureStage.unknown");
      currentFile = null;
      console.error("[EPUB converter] Conversion failed", {
        error: error || message,
        filename: failedFile.name,
        mode: this.mode,
        useJieba: this.useJieba,
        state: this.state,
      });
      clearProgressQueue();
      const mustResetWorker = forceWorkerReset
        || error?.name === "RuntimeError"
        || error?.cause?.name === "RuntimeError"
        || error?.phase?.startsWith?.("initializing");
      if (mustResetWorker) terminateWorker();
      this.failures.push({ filename: failedFile.name, stage });
      this.showSnackbar(t("app.batch.fileFailed", { filename: failedFile.name }));
      batchIndex += 1;
      this.convertNextFile();
    },

    finishBatch() {
      const success = this.downloads.length;
      const failed = this.failures.length;
      currentFile = null;
      batchConfig = null;
      batchCustomDictionary = null;
      this.fileHeading = success
        ? t("app.batch.complete", { success })
        : t("app.batch.failedAll");
      this.fileDescription = t("app.batch.summary", { success, failed });
      this.fileIcon = success && !failed
        ? "is-circle-check-icon is-positive"
        : "is-circle-exclamation-icon is-negative";
      this.state = success ? ConversionState.COMPLETE : ConversionState.FAILED;
      if (failed) this.showSnackbar(t("app.batch.summary", { success, failed }));
    },

    handleWorkerMessage(event) {
      if (event.data?.type === "progress") this.queueProgress(event.data);
      if (event.data?.type === "complete") this.queueCompletion(event.data);
      if (event.data?.type === "error") {
        this.failCurrentFile(event.data.error.message, event.data.error);
      }
    },

    cancelConversion() {
      if (!this.isConverting || !selectedFiles.length) return;
      clearProgressQueue();
      terminateWorker();
      this.revokeDownloads();
      this.failures = [];
      currentFile = null;
      batchIndex = 0;
      batchConfig = null;
      batchCustomDictionary = null;
      this.updateSelectionSummary();
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
      if (!files?.length) return;
      this.selectFiles(files, true);
    },
  },
}).mount("#app");
