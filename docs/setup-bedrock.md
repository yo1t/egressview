# Amazon Bedrock (AI insights) setup

EgressView can use Amazon Bedrock as the AI provider for the AI Insights tab.
Bedrock is **keyless**: EgressView never stores AWS credentials. Authentication
is delegated entirely to the AWS SDK for JavaScript v3 **default credential
provider chain**. You configure only an AWS **region** and a **model /
inference-profile ID** in the settings UI.

> AI is read-only. Only bounded, anonymized aggregates are sent — never raw IPs,
> MAC addresses, device names, router credentials, or full connection logs.

## Prerequisites

The AWS SDK (`@aws-sdk/client-bedrock-runtime` and `@aws-sdk/client-bedrock`)
ships as a standard dependency, so `npm install` already includes Bedrock
support — no separate install step.

1. An AWS account with Amazon Bedrock enabled in your chosen region.
2. **Model access granted** for the model(s) you intend to use (Bedrock console →
   *Model access*). Access is per-region and per-model.
3. Credentials resolvable by the AWS SDK default chain on the host running
   EgressView (see below).

## Authentication by environment

EgressView does not implement its own credential lookup order. It relies on the
AWS SDK v3 default chain (roughly: environment variables → SSO cache → Web
Identity → shared config/credentials files → EC2/ECS/EKS instance metadata). The
first resolved credential is used, and expiring temporary credentials are
refreshed by the SDK.

- **EC2 / ECS / EKS:** attach an instance profile / task role / IRSA role with
  the required Bedrock permissions. Nothing else to configure.
- **Home server / VPS / Docker (outside AWS):** provide `AWS_ACCESS_KEY_ID` and
  `AWS_SECRET_ACCESS_KEY` as environment variables, or a shared credentials file
  (`~/.aws/credentials`, e.g. via `aws configure`).
- **AWS IAM Identity Center (SSO):** run `aws sso login` so the SDK can resolve
  temporary credentials from the portal session. **If the SSO portal session
  expires, EgressView cannot refresh it automatically — run `aws sso login`
  again.** The connection test will report a credential error until you do.

## Required IAM permissions

- **Generation (required):** `bedrock:InvokeModel` on the model/inference-profile
  you use. The Converse API is authorized via `bedrock:InvokeModel`.
- **Cross-region inference profiles:** when you use a geographic profile (see
  below), grant `bedrock:InvokeModel` on the **inference profile** *and* on the
  **underlying foundation model resources in each destination region** of that
  geography.
- **Model discovery (optional):** `bedrock:ListFoundationModels` and
  `bedrock:ListInferenceProfiles` populate the model dropdown. Discovery is
  fail-open — without it you simply type the model/profile ID directly. Note
  that listing succeeding does **not** imply `bedrock:InvokeModel` is granted,
  which is why the connection test also performs a minimal generation call.

## Region and model / inference-profile selection

In *Settings → AI Insights*, choose **Amazon Bedrock**, then set:

- **AWS region (source region):** e.g. `ap-northeast-1` (Tokyo), `us-east-1`.
- **Model:** a foundation model ID, a **cross-region inference profile ID**, or
  an ARN. You can pick from discovered options or type the ID directly.

### Cross-region inference (CRIS)

Any CRIS option can be selected — not just Japan:

| Selection | Profile prefix | Data routing |
|-----------|----------------|--------------|
| Global | `global.` | All commercial regions (no geographic boundary) |
| US | `us.` | Regions within the US geography |
| EU | `eu.` | Regions within the EU geography |
| APAC | `apac.` | Regions within the APAC geography |
| **Japan** | `jp.` | Tokyo (ap-northeast-1) & Osaka (ap-northeast-3) — in-Japan processing |
| Australia | `au.` | Regions within the Australia geography |

Geographic profiles keep the entire inference request within that geography;
**Global** may route to any commercial region (no residency guarantee). Choose
based on your latency, throughput, and data-residency requirements. For Japanese
data-residency needs, use a `jp.` profile (e.g.
`jp.anthropic.claude-sonnet-4-5-20250929-v1:0`).

**Availability depends on AWS.** Not every model has a profile in every
geography (for example, Japan CRIS launched for specific Claude models). If a
geography is required, you are limited to models that offer a profile there.

## Guardrails (optional, off by default)

You can attach an Amazon Bedrock Guardrail to Bedrock generations. In
*Settings → AI Insights*, enable **Use Bedrock Guardrails** and enter the
guardrail **ID/ARN** and **version** (defaults to `DRAFT`). When enabled, the
guardrail is passed to Converse via `guardrailConfig`. Requires
`bedrock:ApplyGuardrail` (plus, for a cross-Region guardrail profile,
`bedrock:ApplyGuardrail` on every destination-Region profile object).

> ⚠ **Guardrails do not guarantee in-Japan processing.** There is **no
> Japan-only (`jp.`) guardrail profile**. The APAC guardrail profile
> (`apac.guardrail.v1:0`) routes across the entire APAC geography — a Tokyo
> source region can route guardrail evaluation to Singapore, Mumbai, Seoul,
> Sydney, etc. So even with a `jp.` model inference profile, enabling a
> cross-Region guardrail can send the same input/output content outside Japan.
> Classifier-flagged inputs/outputs may also be retained for up to 30 days for
> abuse detection.
>
> If in-Japan data residency is required, either keep Guardrails **off**, or use
> a **single-Region guardrail in the calling region** (e.g. ap-northeast-1)
> rather than a cross-Region guardrail profile.

## Connection test

The **Save & test connection** button, for Bedrock, both:

1. runs fail-open model discovery to populate the dropdown, and
2. sends a minimal fixed-string generation request via Converse to verify
   `bedrock:InvokeModel` actually works (no network/device/threat data is sent).

A credential, permission, throttling, timeout, or unsupported model/region
problem is reported as a short error message.
