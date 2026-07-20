# Amazon Bedrock (AI insights) setup

EgressView can use Amazon Bedrock as the AI provider for the AI Insights tab.
Bedrock is **keyless**: EgressView never stores AWS credentials. Authentication
is delegated entirely to the AWS SDK for JavaScript v3 **default credential
provider chain**. You configure only an AWS **region** and a **model /
inference-profile ID** in the settings UI.

> AI is read-only. Bounded connection aggregates, device inventory, and network-
> node summaries are sent. Credentials, device notes, raw logs, and management
> addresses are never sent.

## Data handling boundary

Bedrock is a cloud service, not a local provider like Ollama: analysis requests
leave the EgressView host and are processed by AWS in the selected model/profile
routing boundary. AWS states that, under standard Bedrock data protection, model
providers do not access customer prompts or completions and inputs/outputs are
not used to train the underlying base models. Some models can expose a different
data-retention mode, including provider-data-sharing terms, so verify the model's
current retention mode before enabling it. EgressView therefore keeps explicit
cloud consent mandatory for Bedrock.

See the AWS documentation for [Bedrock data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html)
and [model data-retention modes](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html).

## Prerequisites

The AWS SDK (`@aws-sdk/client-bedrock-runtime` and `@aws-sdk/client-bedrock`)
ships as a standard dependency, so `npm install` already includes Bedrock
support — no separate install step.

1. An AWS account with Amazon Bedrock enabled in your chosen region.
2. **Model access / subscription** for the model(s) you intend to use.
   Serverless foundation models are auto-enabled on first invocation, but
   third-party **AWS Marketplace-served models (e.g. Anthropic Claude) require a
   one-time subscription** — see [Marketplace subscription](#marketplace-subscription-first-time-only) below.
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

### Least-privilege IAM example

Limit the runtime role to the inference profile and foundation models it actually
uses. The following is a skeleton for a `jp.` profile. Replace `ACCOUNT_ID`,
`PROFILE_ID`, and `MODEL_ID`, and keep the destination Regions aligned with the
profile's current definition.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeConfiguredProfile",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "arn:aws:bedrock:ap-northeast-1:ACCOUNT_ID:inference-profile/PROFILE_ID"
    },
    {
      "Sid": "InvokeOnlyThroughConfiguredProfile",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": [
        "arn:aws:bedrock:ap-northeast-1::foundation-model/MODEL_ID",
        "arn:aws:bedrock:ap-northeast-3::foundation-model/MODEL_ID"
      ],
      "Condition": {
        "StringEquals": {
          "bedrock:InferenceProfileArn": "arn:aws:bedrock:ap-northeast-1:ACCOUNT_ID:inference-profile/PROFILE_ID"
        }
      }
    },
    {
      "Sid": "DiscoverModelsAndProfiles",
      "Effect": "Allow",
      "Action": [
        "bedrock:ListFoundationModels",
        "bedrock:ListInferenceProfiles"
      ],
      "Resource": "*"
    }
  ]
}
```

Use the model ARNs returned by `GetInferenceProfile` to avoid manually guessing
destination Regions. Compare the policy with the
[AWS geographic-profile IAM example](https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html)
and review it when the selected profile changes.

Only when Guardrails are enabled, add `bedrock:ApplyGuardrail` for the selected
guardrail ARN and, only for settings-page discovery, `bedrock:ListGuardrails`
with `Resource: "*"`. Remove the discovery statement if model IDs are entered
manually. Do not leave Marketplace subscription permissions on the runtime role.

## Marketplace subscription (first-time only)

Third-party models served through **AWS Marketplace (e.g. Anthropic Claude)**
must be **subscribed once per account** before they can be invoked. Until then,
invocation fails with:

> `AccessDeniedException ... not authorized to perform the required AWS
> Marketplace actions (aws-marketplace:ViewSubscriptions, aws-marketplace:Subscribe)`

even when `bedrock:InvokeModel` is granted with `Resource: "*"`. The
`aws-marketplace:*` permission is only needed **at subscription time** — once the
subscription exists it **persists account-wide** and `bedrock:InvokeModel` alone
is enough. Amazon's own models (e.g. Amazon Nova) need no Marketplace
subscription.

Complete the subscription **once**, then keep the runtime role least-privilege:

**Option A (recommended) — an admin subscribes; the service role is untouched.**
A user/principal that holds `aws-marketplace:ViewSubscriptions` and
`aws-marketplace:Subscribe` invokes the model once (Bedrock console playground,
AWS Marketplace console, or CLI). The subscription then covers the whole account.

**Option B — temporarily grant the service role, then remove it.**

1. Add to the EgressView role, save:
   ```json
   { "Sid": "BedrockMarketplaceSubscribe", "Effect": "Allow",
     "Action": ["aws-marketplace:ViewSubscriptions", "aws-marketplace:Subscribe"],
     "Resource": "*" }
   ```
2. Invoke the model once (e.g. the settings **Save & test connection** button, or
   `aws bedrock-runtime converse ...`). Propagation can take ~2 minutes. For a
   `jp.`/`apac.` profile, invoke until it succeeds consistently, since the profile
   routes across multiple destination Regions (Tokyo + Osaka for `jp.`) and each
   must be subscribed.
3. **Remove the `BedrockMarketplaceSubscribe` statement** to return to
   least-privilege. The subscription remains; generation keeps working with just
   `bedrock:InvokeModel`.

> **Re-subscription:** switching later to a **different, not-yet-subscribed
> model** requires the subscription again — either repeat Option A/B for that
> model, or have an admin subscribe it. Removing the permission is not
> permanent lock-out; it just means new models need a fresh one-time subscribe.

> **Org restrictions:** if an AWS Organizations **SCP** or a **Private
> Marketplace** blocks subscribing, even a user with `aws-marketplace:Subscribe`
> cannot complete it — an organization/procurement admin must allow the
> subscription or add the product to the Private Marketplace.

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

## Model invocation logging (optional, off by default)

Bedrock can deliver Converse invocation records to CloudWatch Logs, S3, or both.
This is an account-and-Region setting in AWS, not an EgressView setting. **When
content logging is enabled, the saved request and response can include the IPs,
hostnames, device names, and MAC addresses sent by EgressView.** Decide retention,
reader roles, KMS encryption, and S3 lifecycle before enabling it.
See the [AWS model invocation logging guide](https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html).

1. In the target Region, open *Bedrock → Settings → Model invocation logging*.
2. Select only required modalities and a CloudWatch Logs destination, a same-account/same-Region S3 bucket, or both.
3. Configure log-group retention and S3 lifecycle, Block Public Access, and SSE-KMS when required.
4. Alarm on `AWS/Bedrock` delivery-failure metrics and verify that a test invocation arrives.

If full content is not required, leave content logging off and use the standard
Bedrock runtime metrics for invocation count, latency, tokens, and errors. Turning
logging off does not delete existing records; retention/lifecycle on the destination
remains necessary.

## VPC interface endpoints (PrivateLink, optional)

For a private-subnet deployment, create at least the
`com.amazonaws.REGION.bedrock-runtime` interface endpoint and enable Private DNS.
EgressView then uses the private route for Converse without a code change. Add
`com.amazonaws.REGION.bedrock` when model or Guardrail discovery must also remain private.
See the [AWS PrivateLink guide for Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/vpc-interface-endpoints.html).

- Allow TCP 443 from the EgressView host in the endpoint security group.
- Restrict the endpoint policy to the runtime role, `bedrock:InvokeModel`, and the selected model/profile.
- Verify that standard `bedrock-runtime.REGION.amazonaws.com` DNS resolves to private addresses in the subnet.
- EgressView does not currently accept a custom endpoint URL, so Private DNS is recommended.
- A cross-Region inference profile enters through the source-Region endpoint and then routes inside AWS; separately verify the profile's residency boundary.

## SDK retries

The default `standard` mode uses exponential backoff with jitter and is recommended
for normal workloads. Consider `adaptive` only for a throttling-heavy, latency-tolerant,
single-resource workload because it may delay the initial request.
The [AWS SDK retry behavior guide](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html)
documents `standard` as the default and `adaptive` as a specialized mode.

```dotenv
AWS_RETRY_MODE=standard
AWS_MAX_ATTEMPTS=3
```

Adaptive mode is not a general performance switch. EgressView's 30-second timeout
and single-flight limit still apply, so excessive attempts may hit the application
timeout before SDK retries finish. Compare throttling, latency, and errors in
CloudWatch after a change, and return to `standard` if it does not help.

## Connection test

The **Save & test connection** button, for Bedrock, both:

1. runs fail-open model discovery to populate the dropdown, and
2. sends a minimal fixed-string generation request via Converse to verify
   `bedrock:InvokeModel` actually works (no network/device/threat data is sent).

A credential, permission, throttling, timeout, or unsupported model/region
problem is reported as a short error message.

## Token usage and estimated cost

Successful Converse usage is appended to schema v7. The AI Insights start page
shows current/previous-month tokens and an estimated USD cost, while each saved
assistant answer shows its provider, model, tokens, and estimate. English uses
`$0.0012`; Japanese uses explicit `USD 0.0012` notation.

This is not the AWS bill. It uses the embedded price table effective when the
request was recorded and excludes Guardrails, prompt caching, tax, exchange
rates, contractual discounts, and other add-ons. Unknown models retain token
counts but no guessed cost. See the [AI Insights setup guide](setup-ai-insights.md).
