# Security Scan Before Push

## Rule

GitHub にコードをプッシュする前に、必ず ASH セキュリティスキャンを実行し、actionable findings が 0 であることを確認すること。

## 手順

1. `/Users/yo1/Library/Python/3.10/bin/ash --mode local` を実行
2. `jq '.metadata.summary_stats.actionable' .ash/ash_output/ash_aggregated_results.json` で 0 を確認
3. 0 でない場合は修正または suppression を追加してから再スキャン
4. actionable: 0 を確認してから `git push` を実行

## 注意

- Docker が必要な場合は起動する（`open -a Docker`）
- ASH のパス: `/Users/yo1/Library/Python/3.10/bin/ash`
- スキャン結果は `.ash/ash_output/` に出力される（gitignore 済み）
- suppression を追加した場合は `.ash/.ash.yaml` の変更もコミットに含める
