# EgressView ロードマップ

> 🌐 [English version](ROADMAP.md)

現在の機能は [README](README.ja.md) を参照してください。

## ✅ 提供中

### Agent for Mac

署名・公証済みのMacアプリは、このMacの外向き通信をプロセス単位で可視化します。ネットワーク監視はpass-onlyのNetwork Extensionを使い、macOSでの承認が必要です。地球儀、通信履歴、ローカルの脅威照合、通知、任意のAI洞察を備えています。パケットの中身は収集しません。Hubへの送信は既定で無効で、明示的な有効化が必要です。

### Agent for Windows

WindowsアプリはローカルサービスでこのPCの外向き通信と通信元プロセスを記録します。Hubなしで履歴と可視化を使え、Hubへの送信は任意です。現在配布中のMSIはAuthenticode未署名のため、インストール前にチェックサムを確認してください。[Windows導入ガイド](apps/agent-windows/README.md)を参照してください。

### Linux conntrack収集（プレビュー）

Linuxの`nf_conntrack`用共通adapterは実装済みで、自動integration testを通しています。OpenWrt、ASUSルーターモード、Ubiquiti実機での確認はまだです。[プレビュー版の設定ガイド](docs/setup-conntrack.ja.md)を参照してください。

## 🚧 計画中

### Linuxルーター実機検証

conntrack adapterは、代表的な物理ルーターで確認するまでプレビュー扱いです。ハードウェア固有の設定条件や失敗時の挙動は、コンテナ上のテストとは異なる可能性があります。

**🙋 実機テスター募集中** — 実装の大半はハードウェアなしで進められますが、実機での検証だけはできません。これらのルーターをお持ちの方は [Issue を立てて](https://github.com/yo1t/egressview/issues)ください。

### 通信ブロック

ブロックルールをルーターに書き込みます（Yamaha は SSH 経由の `ip filter`）。まずは手動承認モードのみ。自動ブロックは、実運用で誤検知率が十分低いと実証できるまで計画しません。

---

それ以外（検討中のアイデアを含む）はすべて [Issues](https://github.com/yo1t/egressview/issues) で管理しています。機能リクエスト歓迎です。
