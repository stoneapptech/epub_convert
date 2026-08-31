# EPUB Convert

EPUB 的簡繁轉換線上工具。支援拖放上傳，且上傳後即刻開始轉換，數秒內即轉換完成。

立刻體驗: https://epub.stoneapp.tech/

## 功能
- 支援 EPUB 簡繁互相轉換
- 支援一次最多 25 本 EPUB 的批次轉換，並會自動略過失敗的檔案
- 支援各地區用語轉換
- 開啟用語轉換時，可開啟 jieba 斷詞以提升轉換品質
- 支援自訂字典，可在瀏覽器中儲存，也可以 JSON 匯入或匯出

## 如何使用
### Web
因為使用了 Worker 與 WASM，檔案必須透過網頁伺服器 (http) 才能使用，不能直接打開 `index.html` (file://)。

以下使用 Python 內建的 `http.server` 為例，在專案根目錄執行以下指令:

```
python -m http.server 8000
```

即可在本機的 http://localhost:8000 存取此工具。

### Command-Line (deprecated)
舊版的 python 支援，已停止維護。

```
pip install -r requirements.txt
python convert.py <epub>
```

### 更新第三方套件
```
npm ci
npm run vendor:update
```

## 第三方套件
- [OpenCC-wasm](https://www.npmjs.com/package/opencc-wasm)
- [TocasUI](https://tocas-ui.com)
- [Zip.js](https://gildas-lormeau.github.io/zip.js/)
- [Vue.js](https://vuejs.org)

第三方套件之開放原始碼授權請見 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)

## 授權
MIT
