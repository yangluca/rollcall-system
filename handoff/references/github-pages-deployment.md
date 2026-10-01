# GitHub Pages 部署靜態 GAS 前端檢查清單

使用情境：已寫好靜態前端（HTML/CSS/JS），要推到 `yangluca.github.io/<repo>` 並連接 GAS Web App。

## 1. 檢查 repo 內容

- [ ] 所有前端檔案（`.html`, `.css`, `.js` 已推送）
- [ ] 字體檔（`.ttf`/`.woff2`）可被讀取
- [ ] `不要` 有 `.gs` 檔案留在 Pages 分支（若有，加 `.nojekyll` 或移出）

## 2. 關閉 Jekyll（強烈建議）

在 repo 根目錄新增：

```bash
touch .nojekyll
git add .nojekyll
git commit -m "Disable Jekyll to prevent build errors"
git push
```

## 3. 用 gh CLI 開啟 Pages

```bash
gh api repos/<owner>/<repo>/pages --method POST --input - <<<'{"source":{"branch":"main","path":"/"}}'
```

## 4. 檢查建置狀態

```bash
gh api repos/<owner>/<repo>/pages --jq '{status, build_type, source}'
gh api repos/<owner>/<repo>/pages/builds --jq '.[0] | {status, error}'
```

常見狀態：
- `building` → 等待
- `built` → 成功
- `errored` → 通常是 Jekyll 問題，加 `.nojekyll` 後重新部署

## 5. 等待生效

Pages 第一次部署可能需要 1–3 分鐘才能用瀏覽器打開。
