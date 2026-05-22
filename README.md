# Codex Reset Watch

這是一個零依賴的小型 PWA，用來讀取 `https://hascodexratelimitreset.today/`，並把結果整理成手機與桌機都好看的狀態卡。

## 啟動

```bash
npm start
```

預設會跑在 `http://localhost:4173`。

## 手機/桌機共用

- 桌機直接開 `http://localhost:4173`
- 手機連同一個 Wi-Fi 後，開啟畫面上顯示的 LAN 網址
- 可在支援的瀏覽器中加入主畫面，變成類 App 圖示

## 功能

- 自動抓取 Codex 額度重置狀態
- 每 60 秒自動刷新
- 顯示最近一次檢查時間與判斷依據
- 支援通知與主畫面安裝
