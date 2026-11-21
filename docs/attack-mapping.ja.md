# EgressViewで分かること・分からないこと（MITRE ATT&CKとの対応）

[English](attack-mapping.md)

このページは、[MITRE ATT&CK](https://attack.mitre.org/)の用語で考えている人が、入れる前に「EgressViewでどの兆候が見えて、どれが見えないか」を確かめるためのものです。行ごとに、関係する技法、画面に何が出るか、何が要るか、どこまで確かめたか、何を見逃すかを書きます。

**EgressViewを使うだけなら、このページは読まなくてかまいません。** 通信がどこへ行くかを見たいだけなら、[概要](../README.ja.md)から始めてください。

## 先に知っておくこと

- **EgressViewが示すのは「調べる価値があるもの」です。マルウェアだと判定することも、通信を止めることもしません。** バックアップ、クラウド同期、OSの更新、初回の同期は、下の兆候のいくつかと同じ形になります。
- **この表に載っているのは「その技法に関係する兆候を示せる」という意味です。** その技法のすべての使われ方を検知するという意味ではありません。MITREがEgressViewを評価・認定したわけでもありません。
- **DLP・EDR・ファイアウォールの代わりにはなりません。** 読むのは通信のメタデータだけで、パケットの中身は読みません。そのため、何が送られたか、機密か、試みが成功したかは分かりません。

## 今の版で示せる兆候

「Hub」はEgressView Hub、「Agent」はMac用またはWindows用のEgressView Agentです。「ルーター」は、Hubが読む対応ルーター（Yamaha RTX・Cisco IOS）です。

| 画面に出るもの | 関係するATT&CKの技法 | 必要なもの | 判定の条件 | 確かめた範囲 | 見逃すもの |
|---|---|---|---|---|---|
| **既知の悪性の宛先への接続**（脅威の通知） | [T1071 Application Layer Protocol](https://attack.mitre.org/techniques/T1071/)（既知の指令サーバー）、[T1105 Ingress Tool Transfer](https://attack.mitre.org/techniques/T1105/)（既知のマルウェア配布元） | HubまたはAgent。abuse.chのFeodo Tracker・URLhaus・ThreatFoxと、Spamhaus DROPのリスト | 宛先のアドレスかホスト名がリストにある | 自動テスト（`test/unit/threat-intel.test.js`、Macの`ThreatMatcherTests`）。開発者自身のネットワークで運用中 | まだリストに載っていないもの（新しい基盤を含む）。リリースの配布元のような共有サービスでの一致は、侵害ではなく確度「低」として出す |
| **同じ宛先へ一定の間隔で接続する機器**（Hubの「ビーコン候補」） | [T1071 Application Layer Protocol](https://attack.mitre.org/techniques/T1071/)（指令サーバーへの定期的な問い合わせ） | Hubとルーター。Agentのデータからは計算しない | 送り元・宛先・ポート・プロトコルが同じ接続が4回以上あり、間隔の中央値が1分〜4時間、変動係数が0.5以下 | 自動テスト（`test/unit/beacon-detector.test.js`） | 間隔をばらつかせた問い合わせ、1分より短い・4時間より長い間隔、ルーターを通らない通信。正当なアプリも一定の間隔で問い合わせることが多いので、一覧に出すだけで通知はしない |
| **このコンピューターが普段よりずっと多く、15分間に送った**（「通常と異なる外向き通信」の通知） | [T1041 Exfiltration Over C2 Channel](https://attack.mitre.org/techniques/T1041/)（大量送信の部分だけ） | Agent | 終わった15分の窓が、100 MiB・普段の中央値の3倍・普段の中央値＋max(16 MiB, 6×MAD)のうち最大のものを超えた。24時間分の履歴が貯まってから判定し、送受信量が取れた接続が80%以上の窓だけを使う | 自動テスト（Macの`OutboundAnomalyDetectorTests`）。実機のMacで、普段の使い方で検知し通知した（2026-09） | 閾値未満の送信、多くの窓に分けた送信、送受信量の取れない通信（下の「見えないところ」） |
| **アプリが初めての宛先へ送った、または知っている宛先へ普段より多く送った**（Agentの「インサイト」の「調べる候補（直近14日）」） | [T1567 Exfiltration Over Web Service](https://attack.mitre.org/techniques/T1567/)と[T1030 Data Transfer Size Limits](https://attack.mitre.org/techniques/T1030/)の、調べる手がかり | Agent（Mac 0.5.139以降、Windows 0.1.165以降） | 監視168時間の後で、次のどれか。新しいアプリと宛先の組が最初の7日で1 MiB以上送った。知っている組が1日に10 MiB以上、かつ普段の90パーセンタイルの5倍以上送った。コンピューター全体が24時間に普段の99パーセンタイルの1.5倍を超えて送った | 共通の試験データ（`test/fixtures/outbound-candidates-cases.json`）に両OSで合格。Mac 1台で、実データの再生と同じ一覧が出た。**実機で未確認**: Macで候補が11件以上のときと小さい画面、学習を終えたWindowsでの一覧 | 週1 MiB未満の新しい組、1日10 MiB未満の知っている組、ブラウザ・仮想マシン（意図して除外）、LAN内の宛先、組ごとに下限を下回るよう分けた送信。通知はせず、Hubへも送らない。Mac 1台では1日に約1件出て、すべて持ち主が使っているアプリだった |
| **コンピューター上のプログラムがLAN内を探した**（「LAN内の探索」の通知） | [T1046 Network Service Discovery](https://attack.mitre.org/techniques/T1046/)、[T1018 Remote System Discovery](https://attack.mitre.org/techniques/T1018/) | Hubと、Hubへ送っているAgent | 1つのプログラムが2分間に、LAN内の30個以上のアドレス、または1つのLAN内アドレスの10個以上のポートへ接続した | 自動テスト（`test/unit/lan-scan-detector.test.js`）。実機のMacとWindows PCで、わざと掃引して端から端まで確認 | もっと遅い探索、Agentの入っていない機器からの探索、プライベートの範囲外のアドレスへの探索 |
| **LAN内の別の機器がこのコンピューターを探った**（送り元を示す「LAN内の探索」の通知） | [T1046 Network Service Discovery](https://attack.mitre.org/techniques/T1046/) | Hubと、Hubへ送っているAgent。Macでは「パケットのヘッダーから数える」をオンにする（既定はオフ） | LAN内の1つの送り元が2分間に、このコンピューターの10個以上のポートへ届いた | 自動テスト（Macの`InboundProbeTests`）。実機のMacとWindows PCで、TCP・UDPとも端から端まで確認 | もっと遅い探り、少数のポートだけの探り、ヘッダーからの計数がオフのMacへの探りすべて |
| **コンピューターはネットワークを使い続けているのに、Agentから届かなくなった**（「Agentから届かない」の通知） | [T1562.001 Impair Defenses: Disable or Modify Tools](https://attack.mitre.org/techniques/T1562/001/)（考えられる原因の1つとして） | Hubとルーター、Agent | Agentから15分届かない間に、ルーターがそのコンピューターの新しい接続を3件以上記録した | 自動テスト（`test/unit/agent-silence-detector.test.js`）。本番のデータで、スリープ・電源オフのような普段の静かな時間に出ないことを確認。本当の停止をまだ捉えたことはない | ルーターの無いHub。よくある原因は、更新や異常終了の後にアプリが戻らなかったことで、攻撃ではない |

## 見えないところ

- **Agentを入れていないコンピューターと、ルーターを通らない通信。** ルーターは背後の機器を見られますが、どのアプリが送ったかは分かりません。LAN内どうしの通信は、たいていルーターを通りません。
- **Macの送受信量。** macOSは、「パケットのヘッダーから数える」をオンにしない限り、多くの接続で送受信量を報告しません。送受信量の取れた接続が80%未満の15分窓は、MacでもWindowsでも判定に使わないので、こうした通信は上の量にもとづく兆候を出せません。
- **Agentが動いていないとき**: 止まっている、スリープ中、更新の後にまだ起動していない。Agentは自分のコンピューターだけで判定し、複数のコンピューターを比べることはしません。
- **Hubへの送信は利用者が選んだときだけです。** Hubが計算する兆候（LAN内の探索、探られた側、Agentから届かない）は、AgentがHubへ送っていることが前提です。
- **中身。** 暗号化の有無にかかわらず、送られた中身は読みません。
- **同じ形になる普段の作業**: バックアップ、クラウド同期、大きなアップロード、更新、新しく入れたアプリ。

## 予定しているが、まだ無いもの

- Hubで複数のAgentの外向き通信を比べること。公開して実機で確かめるまで、このページではできるとは書きません。

## 関連するページ

- [脅威の調査](manual-threat-investigation.ja.md): 脅威の通知が来たときにすること。
- [Mac用Agentが送る情報](agent-privacy.ja.md) · [Windows用Agentが送る情報](agent-privacy-windows.ja.md)
