# Calenso Enhanced Conversions Pipeline

## Project Overview

This repository documents a production-grade Google Ads Enhanced Conversions pipeline for Calenso bookings, implemented with n8n and deployed as a Docker Compose stack.

The system receives customer-side Calenso booking events, validates and normalizes the required conversion data, hashes first-party customer identifiers, and uploads a Google Ads `ConversionAdjustment` with `adjustmentType = ENHANCEMENT`.

## Business Problem

Calenso booking conversions need to be correlated with Google Ads campaigns without exposing unnecessary customer data.

The solution links the browser-side Google Ads conversion and the server-side enhancement through the same booking identifier, while minimizing what reaches Google Ads and keeping webhook authentication outside n8n.

## Architecture

```text
Customer booking
  -> Calenso
  -> Tailscale Funnel
  -> Caddy reverse proxy
  -> secret-header validation
  -> header stripping
  -> n8n
  -> data validation
  -> customer identifier normalization
  -> SHA-256 email/phone hashing
  -> Google Ads ConversionAdjustment ENHANCEMENT
```

Google Tag Manager sends the original Google Ads website conversion from the customer browser. n8n sends the server-side `ENHANCEMENT` for the same booking.

```text
GTM transaction_id = Calenso appointment UUID
n8n orderId       = Calenso appointment UUID
```

This avoids creating a second independent conversion and instead enhances the original website conversion.

## Production Infrastructure

- AWS EC2 Ubuntu 24.04
- Docker Compose
- n8n `2.27.4`
- Tailscale Funnel
- Caddy reverse proxy
- Persistent Docker volumes for runtime state
- Environment-based deployment configuration
- Pinned container versions for reproducibility
- Google OAuth credential managed in n8n, outside Git
- Secrets stored outside Git in ignored environment files

No IP addresses, account IDs, production secrets, customer IDs, credential IDs, real emails, phone numbers, hashes, or sensitive identifiers are documented in this repository.

## Security Design

Caddy is the security boundary in front of n8n.

- Calenso sends a custom `X-Calenso-Webhook-Secret` header.
- Caddy validates the secret before proxying webhook traffic.
- Missing secret -> HTTP `403`.
- Wrong secret -> HTTP `403`.
- The secret header is stripped before the request reaches n8n.
- Secrets are injected from environment variables and are not stored in Git.
- Raw customer identifiers are not sent to Google Ads.
- Google Ads receives SHA-256 hashed identifiers.
- Phone is optional; missing or invalid phone falls back to email-only enhancement.

This design prevents unauthenticated public webhook calls and avoids persisting the webhook secret in n8n execution data.

## Data Flow / Processing

```text
Input
  -> Validate
  -> Normalize
  -> Hash
  -> Prepare payload
  -> Google Ads upload
```

The workflow validates booking structure, normalizes customer identifiers, hashes eligible first-party identifiers, prepares the Google Ads adjustment payload, and uploads it through the Google Ads API.

## Google Ads Integration

The pipeline uses one Google Ads conversion action.

- GTM sends the original website conversion.
- n8n sends `ConversionAdjustment` with `adjustmentType = ENHANCEMENT`.
- `appointment_uuid` is reused as Google Ads `orderId`.
- Email and phone hashes are sent as separate `UserIdentifier` objects.
- No second normal conversion upload is created by n8n.
- Empty or null phone identifiers are not sent.

Google OAuth 2.0 credentials are managed in n8n and are not exported into Git.

## Production Acceptance Tests

The AWS production deployment was acceptance tested with sanitized evidence only:

- n8n health HTTP `200`
- Caddy -> n8n HTTP `200`
- Missing webhook secret -> HTTP `403` PASS
- Wrong webhook secret -> HTTP `403` PASS
- Public Funnel missing-secret request -> HTTP `403` PASS
- Real Calenso customer booking reached AWS n8n
- Workflow execution `SUCCESS`
- Google Ads upload executed once
- Google Ads API returned results
- No partial failure/error observed
- `adjustmentType = ENHANCEMENT` confirmed
- `appointment_uuid -> orderId` MATCH
- Hashed email present
- Hashed phone present
- Raw email/phone absent from the Google Ads request
- Webhook secret absent inside n8n

Production payloads, execution payloads, real customer identifiers, hashes, secrets, tokens, customer IDs, conversion action IDs, and appointment IDs are intentionally excluded.

## Reliability / Deployment

- The system runs independently of the local Windows PC.
- AWS is the always-on runtime.
- Git `main` represents the known-good production configuration.
- Deployment is intentionally manual and controlled, not automatic.
- Rollback is possible using the known-good Git version and the documented Caddy transition configuration.

The production gateway starts in strict mode by default. A transition Caddy configuration remains available for deliberate operational rollback.

```bash
docker exec calenso-caddy-gateway caddy reload --config /etc/caddy/Caddyfile.transition --adapter caddyfile
```

Directly bypassing Caddy is not the normal rollback while Calenso sends the production secret, because that could expose the webhook secret to n8n execution data.

## Privacy Hardening Development

A separate branch, `fix/pii-lifecycle`, contains an additional tested PII lifecycle hardening change with deterministic `9/9` regression tests.

That branch is intentionally not merged into production `main` yet because `main` is being preserved as the currently verified production state.

Production does not send raw email or raw phone values to Google Ads.

## Repository Structure

```text
calenso-enhanced-conversions/
|-- docker-compose.yml
|-- docker-compose.production-gateway.yml
|-- .env.example
|-- README.md
|
|-- infra/
|   `-- caddy/
|       |-- Caddyfile.production
|       `-- Caddyfile.production-transition
|
`-- workflows/
    |-- calenso-enhanced-conversions-pipeline.json
    `-- calenso-phone-enhancement-test.json
```

Important files:

- `docker-compose.yml`: base n8n and Tailscale services
- `docker-compose.production-gateway.yml`: production Caddy gateway service
- `infra/caddy/Caddyfile.production`: strict webhook authentication gateway
- `infra/caddy/Caddyfile.production-transition`: explicit rollback gateway config
- `workflows/calenso-enhanced-conversions-pipeline.json`: production n8n workflow export
- `workflows/calenso-phone-enhancement-test.json`: isolated sanitized n8n regression workflow

## Environment Configuration

Create a local `.env` from `.env.example`. Real values must never be committed.

Required deployment configuration includes:

- Tailscale hostname and auth settings
- n8n public URL settings
- persistent `N8N_ENCRYPTION_KEY`
- Google Ads developer token
- Calenso webhook secret

The Compose configuration is designed for staged deployments by allowing hostnames and public URLs to be supplied through environment variables.

## Skills Demonstrated

- n8n workflow automation
- REST API integration
- Google Ads API
- OAuth 2.0
- webhook security
- reverse proxy design
- Docker / Docker Compose
- AWS EC2 deployment
- Tailscale Funnel
- Caddy
- SHA-256 hashing
- data minimization
- environment configuration
- production debugging
- regression testing
- controlled deployment
- rollback strategy
- observability / health checks
- root-cause analysis

## Status

**Production deployed / acceptance tested.**

This repository is a portfolio-grade automation project demonstrating secure webhook ingestion, privacy-aware data processing, and Google Ads Enhanced Conversions integration.

