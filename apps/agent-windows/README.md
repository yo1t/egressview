# EgressView Agent for Windows

Phase 1の最小vertical sliceです。ネットワーク観測をbounded channelで受け、Windows標準SQLiteへ
batch保存し、再起動後の整合性とprivacy-safeな診断を確認します。

ETW collectorとSCM service hostを含みます。ETW session開始には管理者権限または`LocalService`が必要です。
最小WPF UIとtray lifecycleを含みます。Named Pipe IPCはインストール時に明示したUIユーザーSIDだけを許可し、
SYSTEMを許可、NETWORKを明示拒否します。Administrators、Everyone、Anonymousは許可しません。

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
dotnet run --project src/EgressView.Agent.Service -c Release -- --diagnostics-bundle .\diagnostics.zip --data .\agent.db
dotnet run --project src/EgressView.Agent.Service -c Release -- --ipc-request '{"v":1,"op":"status"}'
dotnet publish src/EgressView.Agent.Service -c Release -r win-x64 --self-contained false -o .\.publish\service
dotnet publish src/EgressView.Agent.Ui -c Release -r win-x64 --self-contained false -o .\.publish\ui
.\scripts\install-dev-service.ps1 -Source .\.publish\service -UiSource .\.publish\ui
```

開発用installerはServiceを`LocalService`として配置し、同時にUIを`ui` subdirectoryへ配置します。
**管理者PowerShellで実行する必要があります。** 既定のtray自動起動は次回ログオンから有効で、installerが
昇格UIをその場で起動することはありません。
既定では実行ユーザーのHKCU `Run`へtray UIを登録します。別ユーザーのSIDを許可する場合は、誤った
HKCUへ登録しないよう停止します。管理者が代理導入するときは`-DisableUiAutoStart`を指定し、対象ユーザー
自身のsessionで起動導線を別途登録してください。更新時は既存UIへ`--exit-ui`を送り、10秒以内に終了
しなければbinaryを上書きせず停止します。UIを終了しても収集Serviceは継続します。

診断bundleはendpoint、process名、credential、raw観測、SQLite DBを含みません。Serviceの収集停止は
Windows Application Event Logのsource `EgressViewAgent`、event ID 1001にも記録します。
