# STORYBOARD

## Frame 1 — 0:00–0:05 — シナリオ

- Status: outline
- Visual: 20個の報告カードが左から台帳へ集まる、温かい企業資料のようなタイトルカード。
- Copy: 「20社の子会社報告を、1つの台帳へ」「架空データによる業務エージェント実演」
- Motion: waterfall entry (`hyperframes-animation/rules/waterfall-entry.md`) と ambient glow bloom (`hyperframes-animation/rules/ambient-glow-bloom.md`)。
- Transition: 5秒でハードカット。

## Frame 2 — 0:05–0:16 — 送信した指示

- Status: outline
- Visual: 録画メタデータに保存された指示文を、再現表示でタイプオン。下部には全文を最初から固定表示する。
- Copy: 指示全文。キーワード「全部読んで」「円換算」「台帳に転記」「確認事項」「保存」を同じ橙色のマーカーで強調。
- Motion: typewriter mechanism (`hyperframes-animation/rules/gsap-effects.md`) と marker highlight (`hyperframes-animation/rules/css-marker-patterns.md`)。
- Integrity note: 「録画メタデータに記録された指示を再現表示」と明示し、実写入力欄を装わない。
- Transition: タイプ完了後3秒静止、送信インジケーターを表示して16秒でハードカット。

## Frame 3 — 0:16–0:42 — 実行 4×

- Status: outline
- Source: `assets/raw-demo.mp4`, source 0–104秒、playback rate 4.0。
- Visual: 実写を左の大きな端末フレームに収め、右側に5段階の進行語を表示。
- Copy: 「全部読んで」「円換算」「台帳に転記」「確認事項」「保存」
- Motion: active step snaps in and locks; source footage remains pixel-faithful (`media-use/references/media-treatment-recipes.md#UI-Fidelity`)。
- Transition: 42秒で台帳の実写へハードカット。

## Frame 4 — 0:42–0:48 — 台帳

- Status: outline
- Source: `assets/raw-demo.mp4`, source 104–110秒、等速。
- Visual: Excel台帳部分へズームし、縦方向にゆっくりパンして転記結果を見せる。
- Copy: 「台帳に転記」「19社提出 / 未提出1社」
- Motion: seek-safe transform pan only; captured pixels are not recolored.
- Transition: 48秒で確認事項へハードカット。

## Frame 5 — 0:48–0:54 — 確認事項

- Status: outline
- Source: `assets/raw-demo.mp4`, source 110–116秒、等速。
- Visual: Excelの確認事項シートへズーム。5件の構成を左のラベルで補助する。
- Copy: 「確認事項 5件」「単位差異3 / 科目名差異1 / 未提出1」
- Motion: camera crop locks in; labels assemble with a short waterfall entry.
- Transition: 54秒で締めカードへハードカット。

## Frame 6 — 0:54–0:58 — 実測と運用境界

- Status: outline
- Visual: 大きな実測値を右、運用境界を左に分けたカード。
- Copy: 「承認済みCopilotのみ」「社外送信なし」「手作業想定1時間 → 実測1.61分」「架空データ」
- Motion: metric bloom and fast structural line draw.
- Transition: 58秒で次のステップへハードカット。

## Frame 7 — 0:58–1:02 — 次のステップ

- Status: outline
- Visual: 余白を広く取り、次の一歩だけを強く残す締めカード。
- Copy: 「次のステップ: 実業務データでの検証」
- Motion: phrase cascade then bounded hold.
- End: 62秒で終了。
