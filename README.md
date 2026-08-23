# Calenso Enhanced Conversions Pipeline

A production-style automation pipeline that connects Calenso customer-side bookings to Google Ads Enhanced Conversions through n8n, Docker, Tailscale Funnel, and a strict Caddy authentication gateway.

The project demonstrates webhook hardening, data minimization, validation, normalization, SHA-256 hashing, and server-side Google Ads `ENHANCEMENT` conversion adjustments.

## Architecture

```text
Customer-side Calenso booking
  |
  +--> Google Tag Manager
  |      |
  |      +--> Google Ads website conversion
  |           transaction_id = Calenso appointment UUID
  |
  +--> Calenso webhook
         |
         +--> Tailscale Funnel :443
                |
                +--> Caddy strict authentication gateway :8080
                       |
                       +--> n8n production workflow
                              |
                              +--> Google Ads API
                                   ConversionAdjustment
                                   adjustmentType = ENHANCEMENT
                                   orderId = Calenso appointment UUID
```

The browser-side Google Ads conversion and the n8n server-side enhancement are matched by the same Calenso appointment UUID:

```text
GTM transaction_id = n8n orderId
```

## Security Boundary

Public webhook traffic is protected before it reaches n8n.

Calenso sends a custom header:

```text
X-Calenso-Webhook-Secret
```

Caddy is the authentication boundary:

* validates `X-Calenso-Webhook-Secret` on the production webhook path
* rejects missing or wrong secrets with `403`
* strips `X-Calenso-Webhook-Secret` before proxying to n8n
* keeps other n8n routes proxied without requiring Calenso webhook auth

The secret is stored outside Git in the ignored local `.env` file and injected into the Caddy container through `CALENSO_WEBHOOK_SECRET`.

Secrets must not be stored in:

* workflow JSON exports
* Caddyfiles
* README or documentation
* Git history
* n8n execution input data

## Source-Level Business Filtering

The Calenso production webhook subscribes only to:

```text
appointment.booking.created
```

Manual/admin bookings are intentionally excluded at the Calenso source level and do not create n8n executions.

## Deployment Behavior

The production gateway is defined in:

```text
docker-compose.production-gateway.yml
```

Strict authentication is the default startup config:

```text
infra/caddy/Caddyfile.production
-> /etc/caddy/Caddyfile
```

The transition config remains available only for deliberate rollback:

```text
infra/caddy/Caddyfile.production-transition
-> /etc/caddy/Caddyfile.transition
```

The gateway runs in the shared Tailscale network namespace and does not publish additional host ports.

## Safe Rollback

While Calenso sends the production secret, the normal rollback is to reload the transition Caddy config:

```bash
docker exec calenso-caddy-gateway caddy reload --config /etc/caddy/Caddyfile.transition --adapter caddyfile
```

Do not use direct `:443 -> n8n :5678` as the normal rollback while Calenso sends the production header. Bypassing Caddy could allow `X-Calenso-Webhook-Secret` to appear in n8n execution data.

## Verified Acceptance Tests

The production security milestone was runtime-verified with sanitized evidence:

* missing webhook secret -> `403`
* wrong webhook secret -> `403`
* rejected requests did not create n8n executions
* legitimate Calenso request with the production secret was accepted
* `X-Calenso-Webhook-Secret` was absent from n8n execution data
* Calenso appointment UUID was present internally
* n8n `orderId` matched the appointment UUID
* Google Ads `ENHANCEMENT` adjustment was accepted
* no Google Ads partial failure was present
* manual/admin booking did not create an n8n execution
* Caddy recreate preserved strict authentication as the startup default
* phone identifier enhancement accepted by Google Ads with no partial failure
* isolated 9-case n8n regression workflow passed

No production payloads, secrets, identifiers, hashes, emails, phone numbers, customer IDs, conversion action IDs, or appointment UUID values are documented in this repository.

## n8n Workflow

Production workflow export:

```text
workflows/calenso-enhanced-conversions-pipeline.json
```

Current production node path:

```text
Receive Calenso Booking
Minimize Conversion Data
Validate Conversion Data
Route Valid Conversion
Normalize Customer Identifiers
Hash Email Identifier
Hash Phone Identifier
Prepare Google Ads Payload
Upload Enhanced Conversion
```

## Data Minimization

Calenso webhook payloads contain more information than required for conversion processing.

The workflow minimizes incoming data before validation, normalization, hashing, and Google Ads upload. Unnecessary customer, staff, service, business, and internal Calenso metadata is not intentionally forwarded to Google Ads.

Current minimized fields include:

```text
event_type
event_created
appointment_uuid
appointment_start_utc
customer_uuid
email
phone
```

## Customer Identifier Processing

Email values are:

1. trimmed
2. lowercased
3. normalized for Gmail / Googlemail dot handling where applicable
4. SHA-256 hashed before transmission to Google Ads

Phone values are treated as optional first-party identifiers. Recent production observations show Calenso currently sends phone values in E.164-style `+...` format. The workflow still keeps defensive normalization and validation for other safe structural forms:

```text
+CC...  -> preserve international country code
00CC... -> +CC...
0...    -> +49...
```

Missing, blank, ambiguous, or invalid phone values produce no phone identifier and fall back to the existing email-only enhancement path.

When a valid phone exists, it is normalized to E.164, SHA-256 hashed, and sent to Google Ads as a separate `hashedPhoneNumber` user identifier. Raw and normalized phone values are removed before payload preparation.

The reusable isolated test workflow is:

```text
workflows/calenso-phone-enhancement-test.json
```

It uses only synthetic data and validates 9 deterministic cases inside n8n without webhooks, credentials, HTTP requests, or Google Ads calls.

## Google Ads Integration

The server-side workflow sends Google Ads Enhanced Conversion adjustments using:

```text
adjustmentType: ENHANCEMENT
orderId: Calenso appointment UUID
conversionAction: calenso1
userIdentifierSource: FIRST_PARTY
hashedEmail: SHA-256 normalized email
hashedPhoneNumber: SHA-256 normalized phone, only when valid
```

Email and phone identifiers are sent as separate `UserIdentifier` objects. Empty or null phone identifiers are not sent.

Authentication uses n8n-managed Google OAuth 2.0 credentials. The Google Ads Developer Token is injected through an environment variable and is not stored in the repository.

## Environment Variables

Create a local `.env` file based on `.env.example`.

```env
TAILSCALE_HOSTNAME=calenso-n8n
N8N_HOST=
N8N_PROTOCOL=https
WEBHOOK_URL=
N8N_EDITOR_BASE_URL=
TAILSCALE_AUTHKEY=your_tailscale_auth_key_here
GOOGLE_ADS_DEVELOPER_TOKEN=your_google_ads_developer_token_here
N8N_ENCRYPTION_KEY=
CALENSO_WEBHOOK_SECRET=your_production_webhook_secret_here
```

Never commit the real `.env` file.

## Docker Usage

The production n8n image is pinned for reproducibility. Production deployments must provide a persistent `N8N_ENCRYPTION_KEY` and must never commit the real value. n8n public URL settings (`N8N_HOST`, `WEBHOOK_URL`, and `N8N_EDITOR_BASE_URL`) are environment-specific and must be supplied through `.env` for non-default deployments. `TAILSCALE_HOSTNAME` allows staged deployments such as a parallel AWS device without changing Compose files. Tailscale state is persisted in a named volume and `TS_AUTH_ONCE=true` avoids unnecessary re-authentication after the device has joined the tailnet.

Start the base environment:

```bash
docker compose up -d
```

Start or recreate only the production Caddy gateway:

```bash
docker compose -f docker-compose.yml -f docker-compose.production-gateway.yml up -d --no-deps calenso-caddy-gateway
```

Force-recreate only the production Caddy gateway after config changes:

```bash
docker compose -f docker-compose.yml -f docker-compose.production-gateway.yml up -d --no-deps --force-recreate calenso-caddy-gateway
```

Do not recreate `calenso-n8n` or `calenso-tailscale` during gateway-only changes.

## Project Structure

```text
calenso-enhanced-conversions/
|
|-- docker-compose.yml
|-- docker-compose.production-gateway.yml
|-- .env.example
|-- .gitignore
|-- README.md
|
|-- infra/
|   `-- caddy/
|       |-- Caddyfile.production
|       `-- Caddyfile.production-transition
|
`-- workflows/
    `-- calenso-enhanced-conversions-pipeline.json
```

## Tech Stack

* Docker
* Docker Compose
* n8n
* Caddy
* Tailscale Funnel
* Calenso Webhooks
* Google Tag Manager
* Google Ads API
* OAuth 2.0
* SHA-256

## Roadmap

Completed:

* Dockerized n8n and Tailscale environment
* Calenso customer-side booking webhook ingestion
* Caddy strict webhook authentication gateway
* Header stripping before n8n
* Source-level filtering for customer-side bookings
* Email-based Google Ads Enhanced Conversion adjustment
* Optional hashed phone identifier enhancement
* Safe transition rollback config
* Isolated n8n phone regression test workflow

Planned:

* duplicate/idempotency protection
* structured error workflow
* retry strategy
* monitoring and alerting
* 24/7 deployment hardening

## Disclaimer

This repository is an educational and portfolio project demonstrating automation architecture and integration patterns.

Successful API submission does not guarantee that Google Ads will ultimately match every Enhanced Conversion to an existing browser-side conversion.

Production use requires appropriate security, privacy, GDPR/data-protection, and platform-specific review.
