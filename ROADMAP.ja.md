# EgressView ロードマップ

> 🌐 [English version](ROADMAP.md)

現在の機能は [README](README.ja.md) を参照してください。

## 🚧 計画中

### macOS クライアント

ルーターのNATテーブルではなく、Mac自身の外向き通信をプロセス単位で可視化するデスクトップクライアントを開発中です。サーバー版を置き換えるものではなく、「ネットワーク全体を広く見る」サーバー版と「1台の端末を深く見る」クライアント版を組み合わせる構想です。

- **軽量監視:** macOSのsocket情報を定期取得します。追加のSystem Extension承認は不要ですが、短時間で終了する通信や通信量を完全には取得できません。
- **フル監視:** pass-onlyのNetwork Extensionで新規flowを取得します。TCP、UDP/QUIC、IPv4/IPv6、プロセス情報を高精度に記録しますが、初回にmacOSの明示的な承認が必要です。
- **プライバシー:** payloadの取得・復号・保存は行いません。Hubへの送信はローカル取得とは分離し、既定OFFの明示opt-inにします。
- **配布:** Developer ID署名・notarization済みappをDMGとHomebrew Caskで配布する計画です。インストールだけで監視を有効化せず、利用者が監視モードを選択します。

共通観測モデル、軽量collector、重複除去、監視モード状態管理、pass-only Network Extension骨格まで技術検証済みです。次にmacOS host app、System Extension連携、ローカル保存、明示opt-inのHub連携を段階的に実装します。正式リリース日は未定です。

### conntrack ルーター対応（OpenWrt / ASUS ルーターモード / Ubiquiti UDM）

Linux の `nf_conntrack` 用共通パーサーを実装することで、OpenWrt、ASUS ルーターモード、Ubiquiti UDM 系など、Linux ベースの多くのルーターに対応できる可能性があります。

**🙋 実機テスター募集中** — 実装の大半はハードウェアなしで進められますが、実機での検証だけはできません。これらのルーターをお持ちの方は [Issue を立てて](https://github.com/yo1t/egressview/issues)ください。

### 通信ブロック

ブロックルールをルーターに書き込みます（Yamaha は SSH 経由の `ip filter`）。まずは手動承認モードのみ。自動ブロックは、実運用で誤検知率が十分低いと実証できるまで計画しません。

---

それ以外（検討中のアイデアを含む）はすべて [Issues](https://github.com/yo1t/egressview/issues) で管理しています。機能リクエスト歓迎です。
