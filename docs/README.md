# EgressView documentation

Start with the [project overview](../README.md) or [日本語の概要](../README.ja.md). EgressView Hub observes a network through routers and optional data sources; EgressView Agent observes its own Mac or Windows PC. Either Agent can run without a Hub. This index groups guides by task rather than by language. Choose **English** or **日本語** in each row.

## Start here

| I want to... | English | 日本語 |
|---|---|---|
| Install Agent for Mac | [Mac guide](../apps/agent-macos/README.md) | [Macガイド](../apps/agent-macos/README.ja.md) |
| Install Agent for Windows | [Windows guide](../apps/agent-windows/README.en.md) | [Windowsガイド](../apps/agent-windows/README.md) |
| Run the Hub | [Quick start](../README.md#run-the-hub) | [クイックスタート](../README.ja.md) |
| Compare what is available and planned | [Roadmap](../ROADMAP.md) | [ロードマップ](../ROADMAP.ja.md) |

Agent installers are available from the [download page](https://dl.egressview.com/). The Hub is not required for local Agent history, and sending observations to a Hub is optional.

## Set up the Hub

| Topic | English | 日本語 |
|---|---|---|
| Yamaha RTX router | [Setup](setup-yamaha.md) | [設定](setup-yamaha.ja.md) |
| Cisco IOS router | [Setup](setup-cisco.md) | [設定](setup-cisco.ja.md) |
| Linux conntrack router (preview) | [Setup](setup-conntrack.md) | [設定](setup-conntrack.ja.md) |
| ASUS access point | [Setup](setup-asus.md) | [設定](setup-asus.ja.md) |
| Configuration and environment variables | [Configuration](configuration.md) | [設定](configuration.ja.md) |
| Run as a service | [Service guide](running-as-a-service.md) | [サービス化](running-as-a-service.ja.md) |
| Authentication and HTTPS | [Authentication](authentication.md) | [認証](authentication.ja.md) |
| Local, private, public, and offline deployment boundaries | [Deployment profiles](deployment-profiles.md) | [配置プロファイル](deployment-profiles.ja.md) |

## Features and integrations

| Topic | English | 日本語 |
|---|---|---|
| AI Insights and model providers | [AI Insights](setup-ai-insights.md) | [AI洞察](setup-ai-insights.ja.md) |
| Amazon Bedrock | [Bedrock setup](setup-bedrock.md) | [Bedrock設定](setup-bedrock.ja.md) |
| MCP access | [MCP setup](setup-mcp.md) | [MCP設定](setup-mcp.ja.md) |
| Remote MCP OAuth provider evaluation | [Evaluation](remote-mcp-oauth-evaluation.md) | [評価](remote-mcp-oauth-evaluation.ja.md) |
| Manual threat investigation | [Investigation](manual-threat-investigation.md) | [脅威調査](manual-threat-investigation.ja.md) |
| REST API | [API reference](api-reference.md) | [APIリファレンス](api-reference.ja.md) |

## Privacy and distribution

| Topic | English | 日本語 |
|---|---|---|
| What Agent for Mac collects and sends | [Mac privacy](agent-privacy.md) | [Macのプライバシー](agent-privacy.ja.md) |
| What Agent for Windows collects and sends | [Windows privacy](agent-privacy-windows.md) | [Windowsのプライバシー](agent-privacy-windows.ja.md) |
| Signed offline distributions | [Offline distribution](offline-distribution.md) | [オフライン配布](offline-distribution.ja.md) |
| Release signing and verification | [Release signing](release-signing.md) | [リリース署名](release-signing.ja.md) |

## Architecture and maintainer references

| Topic | English | 日本語 |
|---|---|---|
| System architecture | [Architecture](architecture.md) | [アーキテクチャ](architecture.ja.md) |
| Code quality assessment (dated snapshot) | [Quality report](quality-report.md) | [品質レポート](quality-report.ja.md) |

The following references currently have no Japanese counterpart: [router pollers](router-pollers.md), [conntrack adapter spec](conntrack-adapter-spec.md), [frontend dependencies](frontend-dependencies.md), and [observation soak procedure](observation-soak.md). Machine-readable references are [OpenAPI](openapi.json), [request schemas](request-schemas.json), and the [MCP publication evidence example](mcp-publication-evidence.example.json).
