# AI Insights setup

AI Insights is EgressView's leftmost tab and start page. Its collection health,
connection, device, destination, threat, and previous-period metrics are local
aggregates and work with no AI provider configured. By default, data is sent to a
model only when an administrator explicitly selects **Analyze** or **Ask**.

## Providers

| Provider | Authentication | Destination |
|---|---|---|
| Ollama | None | Configured local/private endpoint |
| Anthropic | API key | Anthropic Messages API |
| OpenAI | API key | OpenAI Responses API |
| Amazon Bedrock | AWS SDK default credential chain | Bedrock Runtime in the selected region |

In *Settings → AI Insights*, choose the provider/model and configure the required
authentication. Cloud providers require explicit data-sharing consent. EgressView
does not accept or store AWS keys for Bedrock; see the [Bedrock setup guide](setup-bedrock.md).

## Data and safety boundary

- Selected-period aggregates include destination IPs, hostnames, threat counts, and up to 30 devices prioritized by activity. Device fields can include IP, name, MAC, vendor, IPv6, first/last seen, source, status, and connection count.
- When ASUS data is available, up to 10 mesh-node summaries are included, with connected-device counts and up to 5 sample devices per node.
- Router/node management addresses, device notes, archived devices, usernames/passwords, enable passwords, API keys, admin tokens, and raw logs are excluded.
- The range is limited to 14 days, prompts/responses are bounded, timeout is 30 seconds, and only one generation runs server-wide.
- Anthropic, OpenAI, and Bedrock require saved consent plus confirmation when analysis runs.
- AI failure or latency cannot stop router collection, SQLite, Socket.IO, or other views.

## Event notifications

The **Event notifications** button opens an off-by-default automation panel:

- scheduled reports can run daily or weekly at a selected local time;
- threat-change analysis can trigger on danger count, new threat destinations, or a warn-plus-danger increase;
- UI history and Slack are independent delivery destinations;
- threat-triggered analysis is bounded by a daily limit of 1–6 and a 15–1,440 minute cause cooldown;
- the delivery test does not invoke AI or consume model tokens;
- **Run now** remains an explicit operation.

Cloud automation requires a separate durable consent checkbox in addition to the
provider's saved sharing consent. The server enforces consent, the global
single-generation limit, idempotent schedule keys, daily limits, and cooldowns;
consent is bound to the selected cloud provider and must be renewed after a
provider change. Closing the browser cannot bypass these controls. Successful and failed events
are appended under schema v8, while successful generation usage remains in the
versioned usage ledger. A failed scheduled attempt remains retryable.

## Conversation history

Schema v6 stores conversations/messages append-only and restores them after
restart. Every assistant answer records its provider and model. For successful
answers recorded under schema v7, the history joins usage by request ID and also
shows input/output/total tokens and estimated cost. Older history keeps its
provider/model without inferred tokens or price.

## Usage and cost

AI Insights shows current/previous-month request counts, input/output/total
tokens, and an estimated USD cost. English uses `$0.0012`; Japanese uses explicit
`USD 0.0012` notation. Language selection never performs currency conversion.

Estimates use the versioned embedded rate table effective when the request was
recorded. The catalog lives in `src/data/ai-pricing.json`; every entry requires
a provider/model matcher, rates, an effective date, and a source URL. Updating it
does not recalculate older rows because each usage row keeps the version and rates
used at invocation time. Unknown models keep their tokens and show an unavailable
price rather than zero. Successful calls where the provider omitted usage are
counted separately from unknown-price calls. When any usage is unpriced, the UI
labels USD as a partial total and separately shows unpriced token/request counts
and model IDs. The settings picker marks each discovered or manually entered
model as price-tracked or price-unavailable before it is used. Guardrails, cached-token tiers, batch/service tiers, tax, exchange
rates, provider/AWS contractual discounts, and provider-side charges for failed
requests are excluded. Use the provider billing console for invoice reconciliation.

## Daily safety limits

Every manual analysis, chat, connection test, and automatic AI notification
reserves a durable SQLite budget entry before the provider is called. Limits
reset at 00:00 UTC. By default, one principal can make 50 requests and use
1,000,000 recorded tokens per day; all principals combined can make 200
requests and use 4,000,000 recorded tokens per provider per day. Failed calls
still consume a request reservation, preventing repeated provider failures from
becoming an unbounded bill. Configure the four
`EGRESSVIEW_AI_*_DAILY_*_LIMIT` variables documented in `.env.example` when a
deployment needs a different ceiling. HTTP `429` is returned before generation
when a limit is reached.

## Privacy choice

Leave AI disabled or use an Ollama endpoint you control when external submission
is not acceptable. Bedrock still sends the request to AWS and is therefore not
equivalent to local Ollama. Under standard Bedrock data protection, prompts and
outputs are not exposed to model providers or used to train base models; verify
the selected model's data-retention mode because provider-sharing exceptions can
exist. For cloud providers, expose EgressView only through HTTPS or a trusted VPN
and keep API keys and the mode-`0600` configuration file protected.
