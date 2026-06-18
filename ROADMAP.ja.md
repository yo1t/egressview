# EgressView ロードマップ

> 🌐 [English version](ROADMAP.md)

現在の機能は [README](README.ja.md) を参照してください。

## 🚧 計画中

### conntrack ルーター対応（OpenWrt / ASUS ルーターモード / Ubiquiti UDM）

Linux の `nf_conntrack` 用共通パーサーを実装することで、OpenWrt、ASUS ルーターモード、Ubiquiti UDM 系など、Linux ベースの多くのルーターに対応できる可能性があります。

**🙋 実機テスター募集中** — 実装の大半はハードウェアなしで進められますが、実機での検証だけはできません。これらのルーターをお持ちの方は [Issue を立てて](https://github.com/yo1t/egressview/issues)ください。

### 通信ブロック

ブロックルールをルーターに書き込みます（Yamaha は SSH 経由の `ip filter`）。まずは手動承認モードのみ。自動ブロックは、実運用で誤検知率が十分低いと実証できるまで計画しません。

---

それ以外（検討中のアイデアを含む）はすべて [Issues](https://github.com/yo1t/egressview/issues) で管理しています。機能リクエスト歓迎です。
