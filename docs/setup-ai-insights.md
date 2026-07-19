# AI Insights setup

AI Insights is EgressView's leftmost tab and start page. Its collection health,
connection, device, destination, threat, and previous-period metrics are local
aggregates and work with no AI provider configured. Data is sent to a model only
when an administrator explicitly selects **Analyze** or **Ask**.

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

- Selected-period aggregates include destination IPs, hostnames, device names, MACs, and threat counts.
- Router management addresses, usernames/passwords, enable passwords, API keys, admin tokens, and raw logs are excluded.
- The range is limited to 14 days, prompts/responses are bounded, timeout is 30 seconds, and only one generation runs server-wide.
- Anthropic, OpenAI, and Bedrock require saved consent plus confirmation when analysis runs.
- AI failure or latency cannot stop router collection, SQLite, Socket.IO, or other views.

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
recorded. Unknown models keep their tokens and show an unavailable price rather
than zero. Guardrails, cached-token tiers, batch/service tiers, tax, exchange
rates, provider/AWS contractual discounts, and provider-side charges for failed
requests are excluded. Use the provider billing console for invoice reconciliation.

## Privacy choice

Leave AI disabled or use an Ollama endpoint you control when external submission
is not acceptable. For cloud providers, expose EgressView only through HTTPS or
a trusted VPN and keep API keys and the mode-`0600` configuration file protected.
