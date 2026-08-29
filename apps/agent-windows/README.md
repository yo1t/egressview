# EgressView Agent for Windows

Phase 1の最小vertical sliceです。ネットワーク観測をbounded channelで受け、Windows標準SQLiteへ
batch保存し、再起動後の整合性とprivacy-safeな診断を確認します。

現時点では開発用で、Windows Service登録、ETW collector、UI、MSIはまだ含みません。

```powershell
dotnet build EgressViewAgent.Windows.slnx -c Release
dotnet run --project tests/EgressView.Agent.Core.Tests -c Release
```
