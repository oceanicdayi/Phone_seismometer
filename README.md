# 手機地震儀（Mobile Seismograph）

一個可直接部署到 GitHub Pages 的純前端手機地震儀。使用瀏覽器 `DeviceMotionEvent` 讀取手機加速度資料，提供即時三軸波形、事件錄製、IndexedDB 歷史保存、回放、JSON/CSV 匯出，以及選配的 GitHub 儲存庫備份。

## 功能

- 即時顯示 X、Y、Z 與合成振幅 `|A|`
- 顯示估計取樣率、錄製峰值、錄製時間
- 錄製名稱、備註與時間標記
- IndexedDB 本機保存，離線後仍可讀取
- 歷史波形回放、速度調整與時間軸拖曳
- 單筆 JSON / CSV、全部 JSON 備份、JSON 匯入
- PWA：支援離線快取及安裝至主畫面
- 選配：使用 GitHub REST API 將每筆紀錄保存到 repo 的 `data/records/`，並可在其他裝置還原

## 立即部署到 GitHub Pages

1. 本專案已部署至 `oceanicdayi/Phone_seismometer`。
2. 專案檔案位於 `main` 分支。
3. 到 **Settings → Pages → Build and deployment**。
4. Source 選 **GitHub Actions**。
5. 等候 `Deploy GitHub Pages` workflow 完成。
6. 用手機開啟 `https://oceanicdayi.github.io/Phone_seismometer/`。
7. 點擊「啟用手機感測器」並授權。

也可不使用 workflow，改用 **Deploy from a branch**，選 `main` / root。

## 手機瀏覽器注意事項

- 感測器通常只允許在 HTTPS 安全環境使用；GitHub Pages 預設提供 HTTPS。
- iPhone / iPad 必須由使用者點擊按鈕後呼叫 `DeviceMotionEvent.requestPermission()`。
- 不同手機、瀏覽器與省電設定會造成不同取樣率。
- 部分瀏覽器可能只回傳含重力的加速度；程式會使用簡易低通估計重力後相減。這不是儀器級校正。
- 手機座標軸會隨裝置方向與硬體定義改變。做比較實驗時，請固定手機方向與擺放方式。

## GitHub 歷史資料備份

GitHub Pages 是靜態網站，不能安全地在程式碼中放置可寫入 repo 的 token。本專案採以下方式：

1. 建立 **fine-grained personal access token**。
2. 只授權目標 repository。
3. Repository permissions 設定 `Contents: Read and write`。
4. 在網頁的 GitHub 備份區輸入 owner、repo、branch、path 與 token。
5. token 只放在目前分頁的 JavaScript 記憶體；不寫入 Local Storage、IndexedDB 或 repository。
6. 可備份單筆或全部紀錄，也可在另一台裝置輸入相同設定後按「從 GitHub 還原」。

### 安全警告

- **絕對不要**把 token 寫入 `app.js`、GitHub Actions workflow、公開 issue、公開文件或 commit。
- 若網站載入了不受信任的第三方 JavaScript，該程式可能讀取頁面中輸入的 token。本專案刻意不使用 CDN 或第三方前端套件。
- 公開 repository 中的 `data/records/*.json` 也會公開。資料若具隱私性，請改用私人儲存庫或真正的後端服務。
- 大量、高頻紀錄不適合長期直接 commit 到 Git。正式研究系統建議改接物件儲存、資料庫或受控 API。

## 本機測試

直接以 `file://` 開啟可能無法取用感測器。可先用本機 HTTP 伺服器測試介面與模擬訊號：

```bash
python -m http.server 8000
```

再開啟 `http://localhost:8000`。真機感測器測試仍建議部署到 HTTPS。

## 資料格式

每筆紀錄包含：

```json
{
  "id": "uuid",
  "schemaVersion": 1,
  "name": "事件名稱",
  "createdAt": "ISO-8601",
  "units": "m/s²",
  "stats": { "peak": 0, "rms": 0, "sampleRate": 0, "durationMs": 0 },
  "markers": [{ "t": 1200, "label": "標記" }],
  "samples": [
    { "t": 0, "x": 0, "y": 0, "z": 0, "m": 0, "rawX": 0, "rawY": 0, "rawZ": 0 }
  ]
}
```

`t` 單位為毫秒；`x/y/z/m` 為移除重力後的加速度或瀏覽器直接提供的線性加速度；`rawX/rawY/rawZ` 是 `accelerationIncludingGravity` 可用時的原始值。

## 使用範圍

這是教學、展示、相對振動觀察與原型驗證工具。手機 MEMS 感測器、瀏覽器事件排程與未經校正的濾波都會影響結果；不可當作正式地震預警、工程判定或經校正的強震儀。
