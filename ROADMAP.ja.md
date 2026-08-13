# EgressView ロードマップ

> 🌐 [English version](ROADMAP.md)

現在の機能は [README](README.ja.md) を参照してください。

## ✅ 提供中

### macOS エージェント

署名・公証済みの macOS エージェントを v1.9.0 で提供しています。ルーターのNATテーブルではなく、Mac自身の外向き通信をプロセス単位で可視化し、サーバー版を置き換えるのではなく補完します。軽量監視（socket情報の定期取得、System Extension承認は不要）とフル監視（pass-onlyのNetwork Extensionで高精度なflowを取得）を選べ、payloadは取得せず、Hubへの送信は既定OFFの明示opt-inのみです。

## 🚧 計画中

### フル機能版 macOS エージェント

macOS エージェントのフル機能版を開発中です。単なるcollectorから、独自のダッシュボードと可視化、オンデバイスでの脅威判定（自宅ネットワークの外にいるMacも守る）、通知、AIインサイトを備えたスタンドアロンアプリへ広げます。エージェント側の変更は1件ごとに署名・公証・再インストールが必要なため、まとめて1つのリリースにします。正式リリース日は未定です。

### conntrack ルーター対応（OpenWrt / ASUS ルーターモード / Ubiquiti UDM）

Linux の `nf_conntrack` 用共通パーサーを実装することで、OpenWrt、ASUS ルーターモード、Ubiquiti UDM 系など、Linux ベースの多くのルーターに対応できる可能性があります。

**🙋 実機テスター募集中** — 実装の大半はハードウェアなしで進められますが、実機での検証だけはできません。これらのルーターをお持ちの方は [Issue を立てて](https://github.com/yo1t/egressview/issues)ください。

### 通信ブロック

ブロックルールをルーターに書き込みます（Yamaha は SSH 経由の `ip filter`）。まずは手動承認モードのみ。自動ブロックは、実運用で誤検知率が十分低いと実証できるまで計画しません。

---

それ以外（検討中のアイデアを含む）はすべて [Issues](https://github.com/yo1t/egressview/issues) で管理しています。機能リクエスト歓迎です。
