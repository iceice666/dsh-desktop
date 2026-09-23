# DSH Mac 客戶端：研讀對照報告

對照對象：[`anywhere-labs/dsh-desktop`](https://github.com/anywhere-labs/dsh-desktop)
（28.6k★、1359 forks、v2.0.14、MIT、社群獨立專案，非官方）

本機參考 checkout：`.ref-upstream/`（sparse checkout，僅 `dsh-plugin-desktop/` + `docs/`）

---

## 一、核心結論

該專案的定位是：**「DSH Desktop: an Electron shell composed as a DeepSeek Harness Cordis plugin」**
—— 桌面殼本身就是一個 DSH 插件，不是外部包裝器。上游 `deepseek-harness/` 以 git submodule
形式 pin 住且**從不修改**。

我先前兩輪的架構推論，**多數獲得驗證，但有一項核心設計被否定**。

### 1.1 獲得驗證的判斷

| 判斷 | 對照證據 |
|---|---|
| Electron main 進程內嵌 DSH host tree | `docs/architecture.md`：「在 Electron main 进程中启动官方 DSH Host」 |
| renderer 從 loopback 同源載入，而非 `file://` | 「Electron 创建 BrowserWindow 并从 loopback 地址加载同源页面」 |
| 不改上游原始碼，用 profile bundle patch 組合 | `cordis.patch.yml` 以 `insert` 疊加 desktop row |
| 保留 loopback webserver（混合式） | `webServer.port` 為一級輸入，`/plugins` 等 route 原樣沿用 |
| 必須走 `connection.authenticatedUrl()` 換 cookie | `index.ts:422`、`host-bootstrap.ts:213`、`main.ts:1816` 三處使用 |

### 1.2 被否定的判斷（重要）

我原先規劃、且經使用者選定的 **IPC carrier 方案**
（`__DSH_TRANSPORT__.rpc` 接管 `rpc.call` + `rpc.open`，含錯誤 marker 重建），
**成熟產品刻意不做**：

> Desktop 没有另造一条 renderer IPC 插件系统，也**不把 Electron API 暴露给页面**。
> Host 再通过 **HTTP/WebSocket Web carrier** 提供普通 Web UI。
> — `docs/architecture.md`

它就用上游原生的 HTTP + WebSocket carrier。理由推斷：

- renderer 維持 `sandbox: true`，完全不碰 Electron API，攻擊面最小
- 不需維護一套平行於 WebSocket mux 的 stream 語意與重連/背壓邏輯
- 上游 carrier 升級時自動跟上，無相容性負債

**技術上我的 IPC 方案仍成立**（已驗證 `rpc.open` 存在會讓 `RemoteStreamMuxClient`
完全休眠，見 `dsh-api-gateway/lib/client.js:1425/1430/1436/1479`），
但它是為 worker preview tunnel 設計的 seam，不是桌面該走的路。

---

## 二、最有價值的單一發現：renderer 認證

這正是我卡住的那一步，而它的做法比我的更完整。

### 我的做法（有缺陷）

```js
await window.loadURL(connection.authenticatedUrl(origin));
```

缺陷：token 留在 renderer 的瀏覽歷史中；且 **subresource、API 請求、WebSocket
upgrade 都不會保留主框架的 query string**。

### 它的做法（`electron-shell-generation.ts:68-89`）

先在視窗自己的 persistent session 內**單獨**完成 token 交換，再載入真正的 URL：

```ts
async function authenticateRendererSession(renderer, spec) {
  const session = renderer.session
  const headers = { [spec.rendererAccessHeader.name]: spec.rendererAccessHeader.value }
  const authenticated = await session.fetch(spec.authenticationUrl, {
    method: 'GET', credentials: 'include', redirect: 'follow',
    cache: 'no-store', headers,
  })
  if (authenticated.status !== 200) throw new Error(...)
  await authenticated.body?.cancel()
}
```

原註解說明了三個設計意圖：

> Exchange the upstream process token inside the BrowserWindow's own persistent
> session **before** its marker-bearing renderer URL is loaded. Keeping the
> exchange separate **preserves the Desktop query markers** across the upstream
> redirect and **keeps the launch token out of renderer history**.

### 再加一層：generation-only 能力 header

`installRendererAccessHeader()`（同檔 135-168 行）用 `webRequest.onBeforeSendHeaders`
對**每一個** HTTP 與 WebSocket 請求注入一個本 generation 專屬的 header：

> Query markers are intentionally insufficient because subresources, API
> requests, and upgrades do not retain the main-frame query string.

且有三重防護，防止能力隨 redirect 外洩：

- `requestBelongsToRenderer()` — 必須來自本 `webContents.id`
- `sameRendererCarrierOrigin()` — 必須是 HTTP origin 或其配對的 WS origin
- `requestComesFromRendererOrigin()` — 非主框架時，frame 與 top frame 的 origin 都要相符
- 進入 listener 先 `withoutRendererAccessHeader()` 剝除既有同名 header

---

## 三、其他可直接借用的設計

### 3.1 視窗選項（`window-options.ts:13-40`）

```ts
export const DESKTOP_RENDERER_SESSION_PARTITION = 'persist:dsh-desktop-renderer'

webPreferences: {
  preload,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,          // ← 我原本設 false，因為要在 preload 用 require
  webSecurity: true,
  partition: DESKTOP_RENDERER_SESSION_PARTITION,  // ← 與其他 session 隔離
}
```

`sandbox: true` 是我方案放棄 IPC carrier 後才能達到的安全等級。
獨立 partition 讓 cookie 不與任何輔助視窗（登入頁等）混用。

### 3.2 Profile patch（`cordis.patch.yml`）

```yaml
- id: web-runtime
  config:
    openBrowser: false    # 桌面啟動沒有終端使用者在等 URL
    printUrl: false
    surfaceContext: true
    trustedHosts: []
```

比我用 `--no-open` 命令列旗標更乾淨——直接在 patch layer 覆寫 row config。
我原本還額外傳 `--port 0`，它則是讓 `desktop-port.ts` 專責管理。

### 3.3 Generation 生命週期

架構文件的硬性約束：

> 任何 profile 或模式切換都会 dispose 当前 generation，再启动新的 generation。
> **Service reference、窗口对象和 subprocess handle 都不能跨 generation 缓存。**

`ElectronShellGeneration` 完整擁有 `BrowserWindow`、`Tray`、所有 listener、
導航限制、外連處理、縮放快捷鍵，且只能透過冪等的 `release()` 釋放。
`electron-shell-generation.ts:600-625` 可見其逐一 `off()` 的對稱清理。

### 3.4 平台差異收斂

`ElectronPlatformStrategy` seam 在啟動時選定一次，Windows/macOS/Linux adapter
各自宣告目錄選擇、Shell 模式切換、更新下載能力。
新平台分支只進 adapter，generation 與 runtime 只保留共用生命週期。

---

## 四、本輪自行驗證的硬成果（對照後仍然有效）

這些是我實測得出、且該專案文件未載明的資訊：

### 4.1 Electron 版本被原生模組鎖死 ★

`node-addon-require-builtin` 內含寫死的 runtime fingerprint 比對：

```
15.0.245.13-electron.0  → electron-43
15.2.124.13-electron.0  → electron-44
15.4.80-electron.0      → electron-45-alpha
```

比對的是 **V8 完整版本字串 + Node 版本**，非 Electron 語意版本：

| Electron | V8 | Node | 結果 |
|---|---|---|---|
| 33.4.11 | 13.0.245.25 | 20.18.3 | ✗ |
| 43.7.3 | 15.0.245.**31** | 24.21.0 | ✗ |
| 43.1.0 | 15.0.245.13 ✓ | 24.**18**.0 | ✗ |
| **43.0.0** | **15.0.245.13** ✓ | **24.17.0** ✓ | **✓** |

→ **只有 Electron 43.0.0 可用**。不讀原生模組的 strings 查不出這件事。

### 4.2 host tree 可在純 Node 內啟動（`scripts/probe-host.mjs` 實測）

```
probe: tree state = 2
probe: service webServer / connection / typertGateway / clientModules / loader = present
probe: gateway.wireStream.open = function
probe: connection.createSharedFetchHandler = function
probe: injection rows = 8      ← 含 57 個 plugin bundle 的 preload URL
probe: disposed cleanly
```

`ctx.emit('webserver/index-inject', table)` 可直接收集完整 injection 表，
不需 webServer 掛 HTTP 路由。

### 4.3 `GET /` 回 401（`scripts/probe-http.mjs` 實測）

```
probe: GET /           -> 401
probe: GET /favicon.svg -> 200 (3721 bytes)
```

證實 `ownsHost` 只影響 client 端判斷，**擋不住 host 端的 index 認證**。
靜態資產公開，index 必須認證 —— 與第二節完全吻合。

### 4.4 環境限制

本 sandbox 環境無法啟動 Chromium（`sandbox initialization failed: Operation
not permitted`），連空白頁探針都掛住。實機驗證需在一般終端進行。

---

## 五、建議

### 方案 A：直接使用該產品（若目標是「用」）
有簽章好的 DMG、插件市場、自動更新、雙發行通道。

### 方案 B：自建，但照正確架構（**已於本輪實作完成**）

放棄 IPC carrier，改用 HTTP/WS carrier + 兩段式認證。實際變更：

| 檔案 | 動作 |
|---|---|
| `src/main/carrier-script.js` | ✅ 已刪除 —— 不再攔截 `__DSH_TRANSPORT__` |
| `src/main/stream-registry.js` | ✅ 已刪除 —— WebSocket mux 自行處理 |
| `src/shared/protocol.js` | ✅ 已刪除 —— 無 IPC 協議需要定義 |
| `src/preload/` | ✅ 已刪除 —— 無任何東西需要橋接 |
| `src/main/browser-access.js` | ✅ 新增 —— generation 能力 token |
| `src/main/renderer-session.js` | ✅ 新增 —— 兩段式認證 + header 注入 |
| `src/main/shell-generation.js` | ✅ 新增 —— 視窗生命週期與冪等 release |
| `src/main/host.js` | ✅ 簡化 —— 移除 `createLocalDispatch` |
| `src/main/index.js` | ✅ 重寫 —— generation 協調與對稱 teardown |

驗證見 [README](README.md#驗證)：`pnpm check` 共 33 斷言，全數不需圖形介面。

保留價值最高的是 `scripts/probe-host.mjs` 與 `scripts/probe-http.mjs`
—— 它們讓 host 層問題能在沒有視窗的情況下被診斷。

### 方案 C：把該專案當上游，只做自己的桌面插件
它的公開 contract 是 `dsh-plugin-desktop/profile-service` 與
`dsh-plugin-desktop/pnpm`。可在其之上寫自己的插件，不必重造殼。
