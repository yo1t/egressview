# Manual threat investigation

EgressView can query AbuseIPDB, VirusTotal, and AlienVault OTX for additional context about a public destination IP.

- No destination is sent automatically.
- A lookup starts only after an administrator enters an IP, presses the lookup button, and confirms the destination.
- Private, local, carrier-grade NAT, benchmark, multicast, and documentation addresses are rejected.
- API keys are stored only in the mode-`0600` EgressView config and are never returned by the API.
- Responses are reduced to a bounded summary and are not stored in the database.

Open **Settings > Threat Detection > Manual external investigation**, enter the API keys for the services you use, and configure the cache and minimum request interval. An empty key field preserves the saved key; select **Delete saved key** to remove it.

Provider quotas and terms remain the administrator's responsibility. EgressView caches successful results and applies a server-side per-provider cooldown, but provider-side limits may be stricter.
