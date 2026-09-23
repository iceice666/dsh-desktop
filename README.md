# dsh-desktop

DeepSeek Harness 的 macOS 桌面客戶端：一個薄的 Electron 殼，在 main process 內
啟動 DSH 的 Cordis host tree，並以 loopback 同源方式載入上游原本的 Web 客戶端。

架構依循 [`anywhere-labs/dsh-desktop`](https://github.com/anywhere-labs/dsh-desktop)
驗證過的作法（見 [FINDINGS.md](FINDINGS.md) 的對照研讀）。

---

## 設計要點

### 不另造 IPC carrier

桌面**不**攔截 `__DSH_TRANSPORT__`、**不**暴露任何 Electron API 給頁面。
Host 照常綁 loopback，client 用上游原生的 HTTP + WebSocket carrier。

因此 renderer 能維持 Chromium 最嚴格的設定：

```js
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  partition: 'persist:dsh-desktop-renderer',
  preload: 'src/preload/platform-mark.cjs',
}
```

唯一的 preload 只在 `<html>` 上設 `data-platform="darwin"`，不橋接任何東西
（沒有 `contextBridge`、沒有 IPC），並且同樣跑在 sandbox 裡。

### macOS 標題列

`titleBarStyle: 'hiddenInset'` 拿掉了原生標題列，視窗只能透過頁面宣告的
`-webkit-app-region: drag` 區域拖動。

- **上游佈局開關**：上游 client 已內建 macOS 版面（header 拖曳區、控制項的
  no-drag 例外、紅綠燈留白），但只在 `<html data-platform="darwin">` 時啟用，
  並預期由 Electron preload 設定。[platform-mark.cjs](src/preload/platform-mark.cjs)
  就只做這件事。
- **全寬拖曳條**：上游只在側欄頂端與開啟中的對話標題列宣告拖曳區；首頁、設定頁
  與側欄收合時頂端仍無法拖動。[titlebar.js](src/main/titlebar.js) 用
  `insertCSS` 在視窗頂端補一條 38px 的 `drag` 條。按鈕、輸入框、連結等互動元素
  以 `no-drag` 挖出，modal 開啟時整條停用。
- **雙擊**：拖曳區上的雙擊由 Electron 原生處理，依照「系統設定 › 桌面與 Dock ›
  連按兩下視窗標題列以…」的選擇縮放或縮到 Dock。

### 兩段式 session 認證

Host 的 `authorizeIndex` 會擋下未認證的 `GET /`（401）。若直接
`loadURL(authenticatedUrl(origin))`，token 會留在 renderer 的瀏覽歷史裡。

因此分成兩步（[renderer-session.js](src/main/renderer-session.js)）：

1. **`authenticateRendererSession`** — 在視窗自己的 session 內用
   `session.fetch` 完成 token 交換。Host 回 303 + `Set-Cookie`，session 的
   cookie jar 跟隨 redirect 後得到 200。此時尚未載入任何頁面。
2. **`window.loadURL(origin)`** — 載入乾淨 URL，cookie 已可放行。

### Generation 專屬能力 header

Host 綁的是真實 TCP port，機器上任何程式都連得到。Cookie 只證明
「完成過交換的瀏覽器」，不足以證明「本 generation 的 Electron renderer」。

`installRendererAccessHeader` 以 `webRequest.onBeforeSendHeaders` 對每個
同源請求注入 32-byte 能力 token。**主框架 query string 不夠用**：
subresource、`/api` 呼叫、WebSocket upgrade 都不會帶上它。

三重條件全部成立才注入，且進入時先剝除頁面自設的同名 header：

- 請求屬於本 `webContents`（所有回報的 id 都須相符）
- 目標是 carrier 的 HTTP origin 或其配對 WS origin
- 發起 frame 與其 top frame 的 origin 都是 carrier

### 視窗封閉性

[navigation-policy.js](src/main/navigation-policy.js) 是純函數，因此可完整測試：

- **只管主框架導覽**。子框架留給 client 自己的內嵌視圖。
- **離開 origin 只阻擋、不外開**。`will-frame-navigate` 對 `about:blank`
  這類內部目標也會觸發，把它們丟給瀏覽器是錯的。
- **另外攔 `will-redirect`**。redirect 可以繞過 `will-frame-navigate` 離開 origin。
- **popup 只放行 `https:` / `http:` / `mailto:`**。把任意 scheme 交給
  `shell.openExternal` 等於讓頁面內容呼叫 OS 註冊的任何 handler。

### Generation 生命週期

[`ShellGeneration`](src/main/shell-generation.js) 單一物件擁有視窗、所有
listener 與 header disposer，以冪等 `release()` 釋放。跨 generation 快取
任何 reference 都會讓舊能力洩漏到新 generation 的流量上。

應用層面另有三項 macOS 行為：

- **單一實例鎖**。第二次啟動不會再開一棵 host tree——兩個 Cordis generation
  會爭用同一個 session store；改為把既有視窗帶到前景。
- **`activate`**。點 Dock 圖示時回到執行中的視窗。
- **`before-quit` 攔截**。Cordis 的 dispose 是非同步的，必須等它釋放
  subprocess 後才真正結束行程。

---

## 執行

### 前置：Electron 版本被鎖死

DSH 的原生模組 `node-addon-require-builtin` 內含寫死的 runtime fingerprint
比對（V8 完整版本字串 + Node 版本）。實測：

| Electron | V8 | Node | |
|---|---|---|---|
| 33.4.11 | 13.0.245.25 | 20.18.3 | ✗ |
| 43.7.3 | 15.0.245.**31** | 24.21.0 | ✗ |
| 43.1.0 | 15.0.245.13 ✓ | 24.**18**.0 | ✗ |
| **43.0.0** | 15.0.245.13 ✓ | 24.17.0 ✓ | **✓** |

→ 目前對應 DSH `0.1.6-alpha.2` 的**唯一可用版本是 Electron 43.0.0**。

同一個原生模組也挑剔跑腳本的 Node：v24.18.0 會以
`arm64 getter is not optional-bti-ldr-x0-this-imm-ret` 失敗。
`pnpm start` 與 `pnpm smoke` 不受影響（用的是 Electron 內建的 Node），
但 `pnpm check` 需要相容版本：

```bash
fnm use dsh-runtime   # 本機驗證過 v24.21.0
```

```bash
pnpm install
```

### 啟動

```bash
pnpm start
```

不需任何設定。app 會跟著 `PATH` 上的 `dsh` 找到你已安裝的 harness，
driving 的是同一份 profile、憑證與已裝插件。

| 環境變數 | 用途 |
|---|---|
| `DSH_ANCHOR` | 選用。指定另一份 harness 的 node_modules anchor |
| `DSH_DESKTOP_PROFILE` | profile 名稱，預設 `web` |
| `DSH_DESKTOP_PORT` | loopback port，預設 `0`（OS 指派） |
| `DSH_DESKTOP_VERBOSE` | `1` 開啟診斷輸出 |
| `DSH_DESKTOP_USER_DATA` | 覆寫 Chromium userData 目錄 |
| `DSH_DESKTOP_APP_NAME` | 覆寫應用程式名稱，預設取 `package.json` 的 `productName` |
| `DSH_DESKTOP_ICON` | 覆寫圖標，`.png`（建議 1024×1024）或 `.icns` |
| `DSH_DESKTOP_BUNDLE_ID` | 覆寫 bundle identifier，預設 `dev.dsh-desktop` |

### 應用程式名稱與圖標

macOS 的選單列名稱、Cmd-Tab 標籤與 Finder 名稱來自 bundle 的 `Info.plist`，
執行中的行程改不了——`app.setName` 只影響 Electron 自己的選單與 About 面板。
所以直接 `electron .` 永遠顯示「Electron」。

`pnpm start` 因此先由 [branded-bundle.js](src/main/branded-bundle.js)
把 `Electron.app` 複製成 `.electron-app/<名稱>.app`（APFS clone，幾乎不佔空間），
改寫 `CFBundleName`、`CFBundleDisplayName`、`CFBundleIdentifier` 並放入圖標，
再從它啟動。輸入（Electron 版本、名稱、bundle id、圖標內容）沒變時會重用。

執行時另外設定 Dock 圖標與 About 面板，因此 `pnpm start:plain`（原本的
`electron .`）至少 Dock 圖標是對的。

每個欄位依序取值，前者優先：

1. 環境變數（`DSH_DESKTOP_APP_NAME`、`DSH_DESKTOP_ICON`）——單次啟動覆寫，不寫檔
2. **設定 → 應用外觀**頁面存下的選擇（`<userData>/branding.json`）
3. 預設值：`package.json` 的 `productName`（`DeepSeek Harness`）；
   [assets/icon.png](assets/icon.png) 與 [assets/icon.icns](assets/icon.icns)，
   沿用上游 MIT 授權圖標，見 [assets/NOTICE.md](assets/NOTICE.md)

改名**不會**搬動資料：userData 固定在 `~/Library/Application Support/dsh-desktop`，
不隨名稱改變。

### 設定頁：應用外觀

DSH 設定面板裡多一個「應用外觀」區塊，可以改名稱、選圖標、還原預設。

| 變更 | 立即生效 | 重新啟動後生效 |
|---|---|---|
| 圖標 | Dock、About 面板 | Finder、Cmd-Tab |
| 名稱 | About 面板、視窗標題 | 選單列粗體名稱、Cmd-Tab |

有需要重新啟動的差異時，頁面會出現「立即重新啟動」。重新啟動不是
`app.relaunch()`——那會重跑**舊的** bundle，而且 bundle 在 app 執行中不能重建
（Chromium 會從裡面啟動 helper）。改由 [relaunch.js](src/main/relaunch.js) 留下一個
detached helper：等舊行程結束 → 重建 bundle → 從新 bundle 啟動。
helper 的輸出寫在 `<userData>/relaunch.log`。

架構依照上游 `dsh-plugin-desktop` 的做法，但只保留必要的部分：

- **Client**：[plugins/dsh-desktop-branding](plugins/dsh-desktop-branding/) 是一個
  只有 client 半邊的 DSH 插件，向 `settings.section` slot 註冊頁面。bundle 是手寫的
  lazy-CJS（與 tsdown 輸出同格式），不需要建置步驟。
- **載入**：[plugins/cordis.patch.yml](plugins/cordis.patch.yml) 在啟動時以
  `--patch` overlay 插入，**不修改** `~/.dsh` 的 profile；從終端跑 `dsh web`
  看不到這個頁面。同一個 overlay 也關掉 `printUrl`，讓 launch token 不會印進終端。
- **Host 路由**：main process 直接在 `webServer` 上註冊
  `/api/dsh-desktop/branding*`（[branding-routes.js](src/main/branding-routes.js)），
  因為 Dock、檔案對話框、重新啟動都需要 Electron，Cordis host 插件拿不到。

路由同時要求：

- 上游 Connection 的 cookie 驗證；
- **本 generation 的能力 header**：只有桌面視窗自己的 session 會附上，
  所以一般瀏覽器即使有 cookie 也進不來，頁面會顯示「僅在桌面應用中可用」；
- 修改類請求還要：`Origin` 完全相符、JSON、4KB 上限、欄位完全吻合。

選圖標用的是原生檔案對話框，頁面**不能**傳入路徑。選中的檔案會先檢查
magic bytes 並試解碼，再複製進 userData（以內容雜湊命名），所以就算原檔之後被
移走，設定也還在。

主視窗仍然 `sandbox: true`，不暴露任何 Electron API（唯一的 preload 只設
`data-platform` 屬性）。

---

## 驗證

整套 gate 不需啟動圖形介面：

```bash
pnpm check
```

| 指令 | 內容 |
|---|---|
| `pnpm check` | 語法 + 單元 + 認證合約 |
| `pnpm test:unit` | 能力 token、header 注入、視窗封閉性、harness 探索、應用程式識別、外觀路由的准入規則與設定檔（無視窗） |
| `node scripts/test-relaunch.mjs` | 在真實視窗內改名 → 重新啟動 → 確認新 bundle 的 `Info.plist` 與新行程（使用拋棄式 userData） |
| `pnpm test:admission` | 對真實 host 驗證完整認證鏈（14 斷言） |
| `pnpm probe:host` | 無視窗檢查 tree 狀態、服務、injection rows |
| `pnpm probe:http` | 區分「host 不服務」與「Electron 無法導覽」 |
| `pnpm probe:window` | 最小導覽探針，不含 DSH，用於判斷 Chromium 本身能否啟動 |
| `pnpm smoke` | **啟動真實視窗並確認 client 掛載後自動退出** |

`pnpm check` 驗證到視窗為止；`pnpm smoke` 驗證視窗本身。後者不信任
`loadURL` 的回傳（空白頁與錯誤頁同樣會 resolve），而是實際檢查 DOM：

```
client mounted: {"title":"DeepSeek Harness","hasBoot":true,"rootChildren":1,
  "text":"New Session\nPlugins\nWorkspaces\nNo sessions yet\nSettings\n…"}
```

`test:admission` 驗證的實際合約：

```
clean GET /              → 401   （視窗不能直接載入裸 origin）
tokenized GET /          → 303 + Set-Cookie (HttpOnly, SameSite=Strict)
clean GET / with cookie  → 200 + <!doctype html> + __DSH_BOOT__
```

並確認伺服器渲染的 index **不含** `dshDesktopBoot`——證實混合式架構下
不需要任何 desktop boot shim。

---

## 已知限制

### 受限環境下的 Electron 旗標

某些沙箱環境會擋住 Chromium 的沙箱與 out-of-process 網路服務，症狀是
`Failed to initialize sandbox` 與 `Network service crashed or was terminated`。
此時 `session.fetch` 會以 `net::ERR_FAILED` 失敗。

繞道方式（**僅為環境屬性，不屬於應用設定**）：

```bash
DSH_DESKTOP_ELECTRON_FLAGS="--no-sandbox --disable-features=NetworkService,NetworkServiceInProcess" \
pnpm smoke
```

一般終端不需要這些旗標。

### 尚未實作

tray、選單、視窗狀態保存、自動更新、打包簽章。

`.electron-app/` 只是開發用 bundle，不是可散佈的正式打包。

### 應用外觀頁的限制

- 依賴 DSH 內部介面：`settings.section` slot、`window.__ModuleLoader__` 的 bundle
  格式、`runProfile` 的 `patchFiles`。和 Electron 版本鎖一樣，升級 DSH 時要重跑
  `pnpm smoke`（它會打開設定頁確認區塊有渲染）。
- 非正方形的 PNG 轉 `.icns` 時會被拉伸，不會裁切。
- 字典只有 `zh`（簡體，跟隨 DSH 自身的 locale）與 `en`。
