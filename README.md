# EPUB 繁簡轉換

在瀏覽器本機使用 [OpenCC WASM](https://www.npmjs.com/package/opencc-wasm) 轉換 EPUB 內容與檔名，並使用 [zip.js](https://gildas-lormeau.github.io/zip.js/) 的 WebAssembly DEFLATE 引擎重新封裝。EPUB 不會上傳到伺服器。

線上版本：<https://epub.stoneapp.tech/>

## 瀏覽器版本

這是無建置步驟的靜態網站。ES modules、Web Workers 與 WASM 必須透過 HTTP(S) 載入，不能直接以 `file://` 開啟。

```bash
python -m http.server 8000
```

接著開啟 <http://localhost:8000/>。靜態主機必須以 `application/wasm` 提供 `.wasm` 檔案，並以 UTF-8 提供 JavaScript。

支援標準繁簡、台灣、香港、地域用語及日文新舊字體模式。含地域用語的台灣與香港模式可選用 Jieba 斷詞。首次使用某個模式時，瀏覽器會從同站載入所需詞典；Jieba 詞典較大。

## Python CLI

CLI 保留原本的簡體轉台灣正體（`s2tw`）功能：

```bash
python -m pip install -r requirements.txt
python convert.py book.epub
```

## 測試

啟動靜態伺服器後開啟 <http://localhost:8000/tests/>，執行瀏覽器測試。若要以 Python 標準函式庫獨立檢查產生的 EPUB：

```bash
python tests/verify_epub.py converted.epub
```

## 第三方元件

OpenCC、zip.js、Tocas UI 與 Vue 3 的瀏覽器版本已固定並存放於 `vendor/`，執行時不需要 npm 或建置步驟。Noto Sans TC 與 Noto Sans SC 由 Google Fonts 載入；無法連線時會使用系統 sans-serif 字型。詳細授權資訊見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

### 更新前端依賴

Node.js 僅用於維護已提交的 `vendor/` 目錄，不是網站的執行階段依賴：

```sh
npm ci
npm run vendor:update
```

更新 `package.json` 中的固定版本並重新執行以上命令後，請一併提交 `package-lock.json` 與 `vendor/` 的變更。CI 可執行 `npm run vendor:check`，確認 `vendor/` 與鎖定的 npm 套件內容一致。
