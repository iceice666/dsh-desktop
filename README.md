# DeepSeek Harness for macOS

DeepSeek Harness 的原生 macOS 桌面應用。它把完整的 DSH 執行環境封裝進一個
`.app`，提供與 Web 版一致的介面，並加上 macOS 原生的視窗、選單與快捷鍵體驗。

- **開箱即用**：安裝版內建 DSH harness，不需要另外安裝 `dsh` 或設定 `PATH`。
- **原生體驗**：隱藏式標題列、半透明側欄、原生選單列快捷鍵、單一實例、Dock 整合。
- **安全預設**：頁面在 Chromium 最嚴格的 sandbox 中執行，不接觸任何 Electron API；
  服務只綁定本機 loopback，並以每次啟動專屬的憑證保護。
- **可自訂外觀**：在設定中修改應用程式名稱與圖標。
- **Nix 支援**：提供 flake 套件與 home-manager 模組。

---

## 系統通知

應用程式在背景、隱藏或最小化時，會在以下情況發送 macOS 系統通知：

- 你發起的對話回合完成，或因錯誤／token 上限而結束。
- 助理需要你回答問題、確認計畫，或核准操作。

通知只顯示一般提示，不包含對話、問題或指令內容；點擊通知會將應用程式帶到前景，
不會自動切換對話。視窗在前景時不另發通知，子代理與自動續跑回合完成也不會觸發通知。
通知不會代替你回答或核准任何操作。

請在 macOS「系統設定 → 通知」允許此應用程式的通知；專注模式或系統通知設定可能使橫幅不顯示。
應用程式必須保持執行：目前關閉最後一個視窗會退出程式，若要在背景等待，請隱藏或最小化視窗。

## 系統需求

| 項目 | 需求 |
|---|---|
| 作業系統 | macOS（Apple Silicon，arm64） |
| 磁碟空間 | 約 850 MB |
| 建置工具 | Node.js 24.21.0 與 pnpm（僅從原始碼建置時需要） |

目前不支援 Intel 或 universal 版本。

---

## 安裝

### 從原始碼建置

```bash
pnpm install
pnpm package        # 產生 dist/DeepSeek Harness.app
pnpm install:app    # 安裝到 ~/Applications（加上 --system 則安裝到 /Applications）
```

建議安裝在 `~/Applications`：應用程式在修改名稱時需要改寫自身的 bundle，
安裝在需要管理員權限的位置時此功能會受限。

本機建置的 app 可以直接開啟。若把 app 複製到其他電腦，第一次開啟時請在 Finder
中按右鍵 →「打開」，或執行：

```bash
xattr -dr com.apple.quarantine "DeepSeek Harness.app"
```

### 使用 Nix（nix-darwin／home-manager）

本 repo 是一個 flake，提供 `packages.aarch64-darwin.default` 與
`homeManagerModules.default`。

```nix
# flake.nix
inputs.dsh-desktop = {
  url = "github:iceice666/dsh-desktop";
  inputs.nixpkgs.follows = "nixpkgs";
};

# home-manager 設定
{ config, inputs, ... }: {
  imports = [ inputs.dsh-desktop.homeManagerModules.default ];

  programs.dsh-desktop = {
    enable = true;
    name = "DeepSeek Harness";   # 選用，應用程式名稱
    icon = ./harness.png;        # 選用，.png（建議 1024×1024）或 .icns
    # bundleId = "dev.dsh-desktop";
  };
}
```

App 會由 home-manager 的 `targets.darwin.copyApps`（`stateVersion` ≥ 25.11 的預設）
複製到 `~/Applications/Home Manager Apps/`，可從 Spotlight 與 Launchpad 開啟；
同時提供 `dsh-desktop` 命令列啟動器。也可以直接執行 `nix run .#default`。

| 選項 | 說明 |
|---|---|
| `enable` | 安裝應用程式 |
| `name` | 選單列、Cmd-Tab 與 Finder 中顯示的名稱，預設 `DeepSeek Harness` |
| `icon` | 應用程式圖標，`.png` 或 `.icns` |
| `bundleId` | Bundle identifier，預設 `dev.dsh-desktop` |
| `package` | 自訂套件；設定後 `name`、`icon`、`bundleId` 不再生效 |
| `dshHome` | 唯讀，應用程式使用的 DSH home 路徑（即 `~/.dsh`） |

`dshHome` 可用來佈署設定檔，例如以 sops-nix 產生桌面應用與 `dsh` 共用的 `.env`：

```nix
sops.templates."dsh-env".path =
  "${config.programs.dsh-desktop.dshHome}/.env";
```

> 由 Nix 管理的 app，名稱與圖標以 Nix 設定為準。應用程式內的外觀設定仍可修改
> 視窗標題、Dock 圖標與「關於」面板，但不會改寫 bundle 本身。

---

## 使用

從 Launchpad、Spotlight 或 Finder 開啟 **DeepSeek Harness** 即可。首次啟動時請依
畫面指示設定 API key。

- 應用程式只會執行一個實例；再次開啟會把現有視窗帶到前景。
- 點擊 Dock 圖標會回到執行中的視窗。
- 結束應用程式時，會等待所有背景工作與子行程正常關閉。
- 從 Finder 或 Dock 開啟時，應用程式會自動讀取登入 shell（zsh、bash、fish）的
  `PATH` 與常用工具鏈變數，因此 Homebrew、cargo、nvm 等安裝的工具都能正常使用。

### 鍵盤快捷鍵

快捷鍵位於原生選單列中，即使焦點在輸入框內也有效。完整列表也可以在
**設定 › 鍵盤快捷鍵**中查看。

| 快捷鍵 | 動作 |
|---|---|
| ⌘ , | 打開設定 |
| ⌘ / | 查看鍵盤快捷鍵 |
| ⌘ B | 切換左側欄 |
| ⌘ ⌥ B | 切換右側面板 |
| ⌘ N、⌘ ⇧ O | 新會話 |
| ⌘ G | 搜尋會話 |
| ⌘ ⇧ [、⌘ ⇧ ] | 上一個／下一個會話 |
| ⌘ 1 … ⌘ 8 | 跳到側欄第 1–8 個會話 |
| ⌘ 9 | 跳到最後一個會話 |
| ⌘ = ／ ⌘ - ／ ⌘ 0 | 放大／縮小／實際大小 |
| ⌃ ⌘ F | 全螢幕 |
| ⌘ W、⌘ M、⌘ Q | 關閉視窗、最小化、結束 |

### 自訂名稱與圖標

在 **設定 › 應用外觀**中可以修改應用程式名稱、選擇圖標，或還原預設值。

| 變更 | 立即生效 | 重新啟動後生效 |
|---|---|---|
| 圖標 | Dock、「關於」面板 | Finder、Cmd-Tab |
| 名稱 | 視窗標題、「關於」面板 | 選單列、Cmd-Tab、Finder |

需要重新啟動時，頁面會顯示「立即重新啟動」按鈕。選擇的圖標會複製一份保存在應用程式
資料夾中，原始檔案之後移動或刪除都不影響。修改名稱不會搬移任何使用者資料。

非正方形的 PNG 圖標會被縮放成正方形（不會裁切）。

---

## 資料位置

| 內容 | 路徑 |
|---|---|
| 應用程式資料 | `~/Library/Application Support/dsh-desktop/` |
| DSH home（設定、憑證、會話、`.env`） | `~/.dsh/`，與命令列版 `dsh` 共用 |
| 桌面應用的 profile（插件、profile patch） | `~/.dsh/profiles/desktop/` |
| 外觀設定 | `~/Library/Application Support/dsh-desktop/branding.json` |
| 重新啟動記錄 | `~/Library/Application Support/dsh-desktop/relaunch.log` |

與上游 DSH Desktop 相同，桌面應用與命令列版 `dsh` **共用 `~/.dsh`**：設定、API key、
`.env`、會話與工作區兩邊都看得到。桌面應用啟動自己的 **`desktop` profile**
（`dsh` 命令列會拒絕使用這個名稱），因此插件與 profile patch 仍與 `dsh web` 分開。
`~/.dsh/cordis.patch.yml` 這一層則同時套用到兩者。

同一個會話同一時間只能由一個程式開啟；若已在 `dsh web` 中開啟，桌面應用會提示
該會話正在使用中。

**從舊版升級**：舊版把資料放在 `~/Library/Application Support/dsh-desktop/dsh-home/`。
第一次啟動新版時會自動搬移一次：`profiles/web` 成為 `profiles/desktop`，會話、工作區、
observational memory 與設定合併進 `~/.dsh`（已存在的內容一律保留，`settings.yaml`
衝突時以 `~/.dsh` 為準並留下備份）。舊目錄不會被刪除，只會留下 `.migrated-to` 標記；
確認一切正常後可以自行刪除。

---

## 進階設定

以下環境變數可以在從終端機啟動時使用：

| 環境變數 | 說明 |
|---|---|
| `DSH_DESKTOP_DSH_HOME` | 覆寫 DSH home 位置（此時不會自動搬移舊資料） |
| `DSH_DESKTOP_PROFILE` | DSH profile 名稱，預設 `desktop`；其他名稱會以 `dsh --profile` 的方式載入 |
| `DSH_DESKTOP_PORT` | 本機服務的 port，預設由系統指派 |
| `DSH_DESKTOP_USER_DATA` | 覆寫應用程式資料目錄 |
| `DSH_DESKTOP_APP_NAME` | 本次啟動使用的應用程式名稱 |
| `DSH_DESKTOP_ICON` | 本次啟動使用的圖標（`.png` 或 `.icns`） |
| `DSH_DESKTOP_BUNDLE_ID` | 覆寫 bundle identifier |
| `DSH_DESKTOP_VERBOSE` | 設為 `1` 以輸出診斷訊息 |

環境變數優先於設定頁中的選擇，且不會寫入設定檔。

---

## 安全性

- **隔離的頁面環境**：視窗以 `contextIsolation`、`sandbox` 與 `webSecurity` 全開的
  設定執行，使用獨立的 session partition，不透過 preload 或 IPC 暴露任何 Electron API。
- **本機專屬服務**：DSH 服務只綁定 loopback。視窗載入前會先在自己的 session 內
  完成認證，啟動 token 不會出現在網址或瀏覽紀錄中。
- **每次啟動專屬的存取憑證**：應用程式會在每個來自自身視窗、且目標為本機服務的請求上
  附加一次性的存取 header。其他程式或瀏覽器即使取得 cookie，也無法使用桌面專屬的功能。
- **封閉的視窗導覽**：視窗無法被導向其他網站。外部連結會在預設瀏覽器中開啟，且只
  允許 `https:`、`http:` 與 `mailto:`。
- **原生檔案選擇**：選擇圖標一律透過系統檔案對話框，頁面無法指定任意路徑；檔案在
  使用前會先驗證格式。

---

## 開發

```bash
pnpm install
pnpm start          # 以本機已安裝的 dsh 啟動開發版
pnpm check          # 語法檢查、單元測試與認證合約測試（不需圖形介面）
pnpm smoke          # 啟動真實視窗，確認介面掛載與快捷鍵運作後自動結束
pnpm package:smoke  # 打包並以全新的資料目錄驗證打包版
```

開發版會使用 `PATH` 上的 `dsh`，並與安裝版一樣使用 `~/.dsh` 中的 `desktop` profile
（開發版會遵循 `DSH_HOME`）；`DSH_ANCHOR` 可以指定另一份 harness 安裝。

若在會阻擋 Chromium sandbox 與網路服務的受限環境中執行 smoke 測試，可以用
`DSH_DESKTOP_ELECTRON_FLAGS` 傳入額外的 Electron 旗標：

```bash
DSH_DESKTOP_ELECTRON_FLAGS="--no-sandbox --disable-features=NetworkService,NetworkServiceInProcess" pnpm smoke
```

### 版本相容性

DSH 的原生模組會比對執行環境的 V8 與 Node 版本，因此 Electron 版本必須與 DSH 版本
精確對應。目前的組合為：

| 元件 | 版本 |
|---|---|
| DeepSeek Harness | 0.1.6-alpha.2（鎖定於 `runtime/pnpm-lock.yaml`） |
| Electron | 43.0.0 |
| Node.js（執行 `pnpm check` 等腳本） | 24.21.0 |

升級 DSH 時請修改 `runtime/`，並確認新版本支援對應的 Electron；打包腳本會實際載入
harness 驗證相容性。使用 Nix 建置時，修改 lockfile 後需同步更新
`nix/package.nix` 中的 `pnpmDeps.hash`。

### 專案結構

| 路徑 | 內容 |
|---|---|
| `src/main/` | Electron main process：DSH host、視窗、認證、選單與外觀管理 |
| `src/preload/` | 標記 macOS 平台的最小 preload |
| `plugins/` | 應用外觀與鍵盤快捷鍵的 DSH client 插件，以及啟動時套用的 profile patch |
| `runtime/` | 打包用的 DSH harness 版本鎖定 |
| `scripts/` | 啟動、打包、安裝、測試與診斷腳本 |
| `nix/` | Nix 套件與 home-manager 模組 |
| `assets/` | 預設圖標 |

---

## 疑難排解

**App 無法開啟，顯示「已損毀」或「無法驗證開發者」**
App 目前使用 ad-hoc 簽章。請右鍵 →「打開」，或移除 quarantine 屬性（見[安裝](#安裝)）。

**修改名稱後 Finder 中的檔名沒有改變**
App 所在目錄不可寫入，或已有同名的 app。請將 app 安裝在 `~/Applications`。

**Agent 找不到 Homebrew 或其他工具**
確認工具已加入登入 shell 的 `PATH`（例如 `~/.zprofile` 或 `~/.zshrc`），然後重新
啟動應用程式。

---

## 已知限制

- 僅支援 Apple Silicon。
- 尚未提供 Developer ID 簽章與公證、DMG 安裝檔及自動更新。
- 尚未支援選單列圖示（tray）與視窗位置保存。
- 應用外觀設定的介面語言目前提供簡體中文與英文。

---

## 致謝

預設圖標沿用上游專案的 MIT 授權圖標，詳見 [assets/NOTICE.md](assets/NOTICE.md)。
架構參考了 [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop)。
