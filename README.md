# Codex Watch

這是一個零依賴的小型 PWA，用來讀取 `https://hascodexratelimitreset.today/`，並把結果整理成手機與桌機都好看的狀態卡。

## 本機啟動

```bash
npm start
```

預設會跑在 `http://localhost:4173`。

## 手機/桌機共用

- 桌機直接開 `http://localhost:4173`
- 手機連同一個 Wi-Fi 後，開啟畫面上顯示的 LAN 網址
- 可在支援的瀏覽器中加入主畫面，變成類 App 圖示

## GitHub Pages

這個專案已經改成可直接部署到 GitHub Pages 的靜態站：

- 前端讀取 `public/status.json`
- GitHub Actions 會在每次部署前先去抓最新狀態
- 之後也會每 10 分鐘自動刷新一次部署

部署時只需要把 repo 推上 GitHub，然後在 repo 設定裡把 Pages source 指到 GitHub Actions。

## 功能

- 自動抓取 Codex 額度重置狀態
- 每 60 秒自動刷新
- 顯示最近一次檢查時間與判斷依據
- 支援通知與主畫面安裝
