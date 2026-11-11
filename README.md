# MonitorCollage（モニター写真作成）

患者写真4枚（正面・斜め・あおり・横顔）を、2×2 の1枚に自動でまとめる iPhone 向け Web アプリ。

- 顔を検出して、頭頂部〜顎先が入る大きさ・位置に自動配置
- 背景を真っ黒に（顔の明るさは変えない）
- 目元ぼかし（自動＋手動調整）
- 写真はすべて端末内で処理し、外部へ送信しない

## 開発
```bash
npm install
npm run dev      # 開発サーバー
npm run build    # 本番ビルド（dist/）
```

`main` に push すると GitHub Actions で GitHub Pages に公開される。

## ドキュメント
- `docs/01_要件定義.md`
- `docs/02_テスト写真の分析.md`
- `docs/03_wireframe.html`
- `docs/04_技術検証結果.md`

> ⚠️ 写真（`testdata/`、`*.jpg` など）は `.gitignore` で除外。公開リポジトリに含めないこと。
