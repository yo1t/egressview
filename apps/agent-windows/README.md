# EgressView Agent for Windows

Phase 1の最小vertical sliceです。ネットワーク観測をbounded channelで受け、Windows標準SQLiteへ
batch保存し、再起動後の整合性とprivacy-safeな診断を確認します。

ETW collectorとSCM service hostを含みます。ETW session開始には管理者権限または`LocalService`が必要です。
UI、Named Pipe IPC、MSIはまだ含みません。

起動時にIP HelperのTCP/UDP tableを一度取得し、`flows`へETWとupsertします。snapshotだけのflowは
バイト数をNULLのまま保持します。`coverage_sessions`は正常停止と強制終了を区別します。

```powershell
dotnet build EgressViewAgent.Windows.slnx -c Release
dotnet run --project tests/EgressView.Agent.Core.Tests -c Release
dotnet run --project src/EgressView.Agent.Service -c Release -- --console --seconds 15 --data .\agent.db --diagnostics .\diagnostics.json
dotnet run --project src/EgressView.Agent.Service -c Release -- --inspect --data .\agent.db
```
