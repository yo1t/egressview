# EgressView Agent for Windows

Phase 1の最小vertical sliceです。ネットワーク観測をbounded channelで受け、Windows標準SQLiteへ
batch保存し、再起動後の整合性とprivacy-safeな診断を確認します。

ETW collectorとSCM service hostを含みます。ETW session開始には管理者権限または`LocalService`が必要です。
UI、Named Pipe IPC、MSIはまだ含みません。

起動時にIP HelperのTCP/UDP tableを一度取得し、`flows`へETWとupsertします。snapshotだけのflowは
バイト数をNULLのまま保持します。`coverage_sessions`は正常停止と強制終了を区別します。

DB migrationはトランザクション内で行い、変更前に`.pre-v2.bak`を作成します。破損DBは空DBとして
作り直さず起動を停止します。disk fullなどの永続化失敗後は新規観測の受付を停止し、診断の
`collector.persistenceError`へ理由を残します。

raw観測と別に`hourly_summary`をprotocol・logical/VPN transport別で更新します。7日・30日の
履歴表示はraw全走査をせず、この集約をrange queryします。開始時刻を含むhour bucketも欠けません。

```powershell
dotnet build EgressViewAgent.Windows.slnx -c Release
dotnet run --project tests/EgressView.Agent.Core.Tests -c Release
dotnet run --project tests/EgressView.Agent.Core.Tests -c Release -- --million
dotnet run --project src/EgressView.Agent.Service -c Release -- --console --seconds 15 --data .\agent.db --diagnostics .\diagnostics.json
dotnet run --project src/EgressView.Agent.Service -c Release -- --inspect --data .\agent.db
```
