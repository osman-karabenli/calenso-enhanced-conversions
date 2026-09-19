# Calenso Enhanced Conversions Pipeline

## Project Overview

This repository documents a production-deployed Google Ads Enhanced Conversions pipeline for Calenso bookings, implemented with n8n and Docker Compose. As of 19 September 2026, the browser-selected UUID matching system is live on AWS, with active workflow `Calenso Browser UUID Matching - Production v2`. Commit `80e1c09` records the 20-minute retry polling change.

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

No production secrets, access tokens, OAuth secrets, webhook secrets, real customer records, email addresses, phone numbers, or customer hashes are intentionally included. The exported workflow and Compose files do contain non-secret deployment metadata—such as Google Ads resource identifiers, an n8n credential reference, and a default Tailscale hostname—which cannot authorize access but should be replaced when reusing the project.

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

This design prevents unauthenticated calls to the protected production webhook path and avoids persisting the webhook secret in n8n execution data.

The strict Caddy rule covers the exact Calenso webhook path. Other routes are forwarded to n8n by the catch-all proxy, so editor access must be protected separately through n8n authentication and deployment or network controls.

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

## Production Live Verification

The AWS production deployment was operator acceptance-tested, and the following live checks were verified on 19 September 2026 with sanitized evidence only:

- Browser-selected UUID matching is deployed on AWS.
- The `calenso-state-store` Docker container is running.
- State persists in the `calenso_state` Docker volume.
- The Caddy browser endpoint route and CORS behavior were verified.
- CORS allows only `https://www.physiotherapie-rieckmann.de`.
- The live Webador listener sends only the selected appointment UUID.
- Live n8n version is `2.27.4`.
- Active workflow: `Calenso Browser UUID Matching - Production v2`.
- The previous production workflow is unpublished and retained for rollback.
- The isolated upload-context workflow executed successfully on n8n `2.27.4`.
- `$('Attach Upload Context').first().json.upload_context` behavior was verified.

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

The live multi-appointment test created two appointments in one booking operation. Calenso sent two separate webhooks. The webhook whose UUID did not match the browser-selected UUID stopped at `Route Matched Enhancement`; only the selected appointment entered the Google Ads upload path. The accepted result was recorded as `MARK_SENT` with reason `GOOGLE_ADS_UPLOAD_ACCEPTED_FOR_ORDER_ID` and `attempts: 1`.

The `Poll Retryable Enhancements` schedule runs every 20 minutes. Normal browser/webhook matching is immediate; the schedule is only a recovery path for failed or incomplete deliveries.

Identifiers and sensitive values from the live test, including UUIDs, email addresses, phone numbers, hashes, secrets, tokens, customer IDs, and conversion action IDs, are intentionally excluded. Google Ads API acceptance confirms API handling of the upload; it does not by itself prove that the conversion was reported or attributed in Google Ads reporting.

Production payloads, execution payloads, real customer identifiers, hashes, secrets, tokens, customer IDs, conversion action IDs, and appointment IDs are intentionally excluded.

## Reliability / Deployment

- The system runs independently of the local Windows PC.
- AWS is the always-on runtime.
- The live AWS system currently follows branch `fix/browser-selected-appointment-matching` at commit `80e1c09`; the branch has not yet been merged into `main`.
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

## Multi-Appointment Matching in Production

Branch `fix/browser-selected-appointment-matching` contains the live multi-appointment matching implementation.

### Assessment

The inspected Calenso webhook payload has no reliable booking group identifier shared by all appointments in the same customer booking operation. Fields such as `parent_id`, `booking_link_id`, and `child_appointments` are empty in the verified sample. Because of that, grouping by customer id, nearby timestamps, or the first webhook would be heuristic and can merge two separate bookings from the same customer.

The production solution keeps the existing Google Ads order id contract:

```text
GTM transaction_id = browser-selected Calenso appointment UUID
n8n orderId       = same browser-selected Calenso appointment UUID
```

For a multi-date booking, Webador already chooses `bookingData[0].uuid` as the browser conversion UUID. The server now waits for an authenticated Calenso webhook with that same UUID before sending the single `ENHANCEMENT`. Other appointment webhooks from the same booking are not enhanced unless the browser also selected their UUID, which it should not do for this conversion.

### Matching Design

- Browser notification endpoint: `/webhook/calenso-browser-selected-appointment`
- Authenticated Calenso endpoint remains: `/webhook/calenso-customer-test`
- Browser notification contains only the selected appointment UUID.
- Browser notification does not contain the Calenso webhook secret, Google Ads data, customer UUID, email, phone, or hashes.
- Browser notification alone never sends a Google Ads request.
- Google Ads upload happens only after a matching authenticated Calenso webhook has supplied validated customer conversion data.
- Duplicate browser notifications and duplicate Calenso webhooks are deduplicated by an atomic state-store claim for the selected `orderId`.
- Reverse arrival order is supported: either side can arrive first.
- Pending browser selections and pending authenticated Calenso webhooks expire after 30 minutes.
- In-flight upload claims carry a unique `delivery_claim_id` and expire after 2 minutes so an unknown/timeout result can be retried in a bounded way.
- Accepted/sent order ids are retained for 30 days, separately from the short pending TTL, so late duplicate webhooks do not become eligible again after 31 minutes.
- Pending buckets are capped at 500 records and accepted order ids at 5000 records. Accepted order ids are not silently removed on capacity pressure; storage pressure is reported as an error. Dead-letter records have their own retention and capacity limits.
- HTTP 429/5xx, connection failures such as `ECONNRESET`, timeout/unknown results, empty 200 responses, and 200 responses without the expected `orderId` are retried by a scheduled workflow path without waiting for a new webhook. Only explicit validation 4xx responses and `partialFailureError` are permanent failures.
- A scheduled retry also recovers persisted `IN_FLIGHT` records whose delivery claim is missing or expired. An active, unexpired claim is left untouched, and `maxUploadAttempts` still bounds recovery.
- The generated `Poll Retryable Enhancements` schedule polls the state-store every 20 minutes.
- HTTP `200` responses containing `partialFailureError` are treated as a non-accepted Google Ads result and are not marked as sent.
- Empty or unexpected HTTP `200` responses are not accepted; the response must contain a result for the expected `orderId`.

The Caddy production gateway must continue validating `X-Calenso-Webhook-Secret` on `/webhook/calenso-customer-test` and stripping that header upstream. The browser endpoint must remain public, but it is not an authority to upload to Google.

The n8n workflow does not use workflow static data for matching. It calls the running `calenso-state-store` container, which persists state in the `calenso_state` Docker volume and serializes state transitions in a single Node process. This avoids direct writes to n8n internal database tables while giving webhook matching, claim creation, retry attempt counting, and upload result updates one persistent decision point. The sidecar creates a state file when absent, writes an atomic replacement and a `.bak` backup, recovers only from a schema-valid backup, and refuses to start when an existing state file is unreadable or no valid backup exists. Request bodies are limited to 64 KiB.

The browser webhook uses n8n `Respond to Webhook` after the state-store HTTP call, so the browser receives HTTP 200 only after the UUID decision has been persisted. Its public response body is reduced to `{ action }` only. The node's normal output still carries the full state-store decision into `Flatten State Store Decision`, so a browser request arriving after Calenso can continue through the upload path. The listener treats a response as success only when its JSON body contains an accepted state-store action (`WAIT`, `SEND_ENHANCEMENT`, or `SKIP`); an empty or unknown 2xx response is retried.

The browser endpoint is intentionally secret-free and accepts only the appointment UUID. The live Caddy route allows CORS only from `https://www.physiotherapie-rieckmann.de`, limits request bodies to 64 KiB, and rejects other origins. The stock Caddy image still does not enable the documented rate-limit plugin, so rate limiting is not active and must not be described as an active protection. The Calenso webhook secret validation and header stripping remain active and unchanged.

### Production Files and Tests

- `lib/appointment-matcher.js`: deterministic matching and retry state machine used by local tests and by the state-store service.
- `services/state-store.js`: small HTTP sidecar used by n8n for atomic matching, claiming, retry polling, and upload result recording.
- `tests/appointment-matcher.test.js`: synthetic no-Google test coverage for matcher, retry, empty 200, connection errors, 429/5xx, missing orderId, partial failure, validation 4xx, timeout, late duplicate, and restart-state scenarios.
- `tests/browser-listener.test.js`: isolated browser listener tests for real `eventName`, array/object `bookingData`, origin/source rejection, invalid UUIDs, and limited retry.
- `tests/state-store.test.js`: starts the local state-store service, checks concurrent claim behavior, verifies file-backed restart persistence, backup recovery, fail-closed corrupt state handling, and the request body limit.
- `tests/workflow-export.test.js`: parses the generated inactive workflow and verifies state-store topology, browser `Respond to Webhook`, retry polling, direct upload-result wiring, and finalize routing structurally.
- `webador/browser-selected-appointment-listener.js`: integrated live Webador listener that preserves Calenso `eventName` passthrough, attaches the selected UUID to the real `appointment_booking_step_success`, and sends only the selected UUID to the browser endpoint.
- `scripts/build-browser-matched-workflow.js`: generates the n8n workflow export from the current production workflow plus state-store claim/finalize/retry paths.
- `workflows/calenso-enhanced-conversions-pipeline.browser-matched.json`: inactive workflow export used as the production source template.
- `workflows/calenso-upload-context-isolated-test.json`: inactive, credential-free n8n 2.27.4 test workflow for validating upload context and Google Ads response assembly without HTTP or state-store calls.

### Webador Live Configuration

The listener in `webador/browser-selected-appointment-listener.js` is live. Its public browser route and CORS policy were verified; the public hostname is intentionally not repeated here.

The live listener is integrated with the existing Webador message listener. It expects Calenso iframe messages from `https://widget.calenso.com`, verifies `event.source` against the Calenso iframe, preserves `event.data.eventName` passthrough to `dataLayer`, captures the selected UUID on `APPOINTMENT_BOOKING_DONE`, and attaches that UUID to the later real `appointment_booking_step_success` event. DONE itself does not create an extra `appointment_booking_step_success` conversion event. The GTM Google Ads trigger condition requiring the UUID regex remains in place.

### Local Verification

Run these local tests without calling Google Ads:

```bash
node tests/appointment-matcher.test.js
node tests/browser-listener.test.js
node tests/state-store.test.js
node scripts/build-browser-matched-workflow.js
node tests/workflow-export.test.js
node -e "JSON.parse(require('fs').readFileSync('workflows/calenso-enhanced-conversions-pipeline.browser-matched.json','utf8')); console.log('workflow json parse PASS')"
```

Covered synthetic cases:

- Single appointment sends exactly one enhancement after browser UUID and authenticated webhook match.
- Multiple appointments in one booking send only the browser-selected UUID.
- Same customer making two separate bookings sends one enhancement per browser-selected UUID.
- Reverse arrival order and duplicate messages are deduplicated.
- Invalid or unmatched browser notifications do not send and expire.
- Listener accepts the real `eventName` message with array or object `bookingData`.
- Wrong origin/source messages are rejected; invalid UUID DONE messages do not notify the server or create UUID-bearing conversion events.
- Repeated DONE while notify is in flight does not send a second browser notification; a repeated real `appointment_booking_step_success` for the same UUID is suppressed.
- UUID-less Google Ads error responses are tied back to the preserved `order_id` and `delivery_claim_id`.
- Google Ads HTTP errors, timeout/unknown results, empty `200` responses, and `partialFailureError` do not mark the order id as sent.
- Scheduled retry can claim the next due failed enhancement without a new browser or Calenso webhook.
- Scheduled retry recovers an expired or missing `IN_FLIGHT` delivery claim, while an active unexpired claim remains protected.
- Restart-state persistence is covered both by JSON serialize/restore of the matcher state and by a real state-store process restart using a file-backed state file.
- Stale upload responses from an older `delivery_claim_id` do not clear a newer active claim.
- Generated workflow topology is parsed and checked for state-store claim/finalize/retry connections; this is more than JSON parse or string matching.

### Live Deployment State

The active AWS workflow is `Calenso Browser UUID Matching - Production v2`, based on branch `fix/browser-selected-appointment-matching` at commit `80e1c09`. The previous production workflow is unpublished and retained for rollback. The live system has been validated without exposing production identifiers or secrets.

The live workflow and infrastructure should still be monitored operationally. The Caddy rate-limit plugin is not active, and Google Ads API acceptance must not be interpreted as proof of reporting or attribution.

Current live configuration confirmed:

- AWS `calenso-state-store` container and `calenso_state` volume.
- Caddy browser route and origin restriction.
- Live Webador UUID-only listener.
- Live n8n `2.27.4` execution.
- Successful isolated upload-context workflow execution.
- Verified `$('Attach Upload Context').first().json.upload_context` behavior.
- Google Ads API reporting/attribution remains subject to the limitation described above.

### Rollback

If the live browser-matched deployment needs to be rolled back:

1. Unpublish/deactivate `Calenso Browser UUID Matching - Production v2` in n8n.
2. Publish/reactivate the previous production workflow.
3. Revert the Webador listener to the previous verified version if required.
4. Keep the GTM UUID regex trigger condition in place.
5. Keep Caddy strict secret validation and header stripping in place.

## Repository Structure

```text
calenso-enhanced-conversions/
|-- docker-compose.yml
|-- docker-compose.production-gateway.yml
|-- .env.example
|-- README.md
|
|-- lib/
|   `-- appointment-matcher.js
|
|-- services/
|   `-- state-store.js
|
|-- scripts/
|   `-- build-browser-matched-workflow.js
|
|-- tests/
|   |-- appointment-matcher.test.js
|   |-- browser-listener.test.js
|   |-- state-store.test.js
|   `-- workflow-export.test.js
|
|-- webador/
|   `-- browser-selected-appointment-listener.js
|
|-- infra/
|   `-- caddy/
|       |-- Caddyfile.production
|       `-- Caddyfile.production-transition
|
`-- workflows/
    |-- calenso-enhanced-conversions-pipeline.browser-matched.json
    |-- calenso-upload-context-isolated-test.json
    |-- calenso-enhanced-conversions-pipeline.json
    `-- calenso-phone-enhancement-test.json
```

Important files:

- `docker-compose.yml`: base n8n and Tailscale services
- `docker-compose.production-gateway.yml`: production Caddy gateway service
- `services/state-store.js`: file-backed persistent state-store service used by the live browser-matched system
- `lib/appointment-matcher.js`: deterministic matching, claiming, retry, and upload-result state machine
- `webador/browser-selected-appointment-listener.js`: live Webador listener that preserves eventName passthrough
- `scripts/build-browser-matched-workflow.js`: generator for the browser-matched n8n workflow export
- `infra/caddy/Caddyfile.production`: strict webhook authentication gateway
- `infra/caddy/Caddyfile.production-transition`: explicit rollback gateway config
- `workflows/calenso-enhanced-conversions-pipeline.json`: production n8n workflow export
- `workflows/calenso-enhanced-conversions-pipeline.browser-matched.json`: inactive state-store-backed source export for the live workflow
- `workflows/calenso-upload-context-isolated-test.json`: inactive isolated upload-context test workflow
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

## Repository Evidence

| Capability | Repository evidence | Verification limit |
|---|---|---|
| Secret-header validation and stripping at the webhook boundary | [`infra/caddy/Caddyfile.production`](infra/caddy/Caddyfile.production) | Protects the exact production webhook path; the secret value remains external |
| Containerized n8n, Tailscale, and Caddy deployment | [`docker-compose.yml`](docker-compose.yml) and [`docker-compose.production-gateway.yml`](docker-compose.production-gateway.yml) | Deployment definitions are included; the live AWS environment is not publicly accessible |
| Data minimization, validation, normalization, and SHA-256 hashing | [`workflows/calenso-enhanced-conversions-pipeline.json`](workflows/calenso-enhanced-conversions-pipeline.json) | Workflow implementation is public; real execution payloads are excluded |
| Google Ads enhancement payload and API upload | [`workflows/calenso-enhanced-conversions-pipeline.json`](workflows/calenso-enhanced-conversions-pipeline.json) | Non-secret resource identifiers and a credential reference remain in the export; credentials and tokens are not included |
| Sanitized phone-handling regression workflow | [`workflows/calenso-phone-enhancement-test.json`](workflows/calenso-phone-enhancement-test.json) | Test workflow is included; production customer data is not used |
| Environment-based secret configuration | [`.env.example`](.env.example) | Placeholder values only; real secrets remain outside Git |

## Verification Scope

- The repository provides public source evidence for the workflow and deployment architecture.
- Production acceptance results are operator-reported from sanitized checks; production logs, payloads, credentials, and Google Ads responses are intentionally excluded.
- The live AWS, Calenso, n8n, Tailscale, and Google Ads environments cannot be independently reproduced from this repository without authorized credentials and deployment-specific configuration.
- The separate `fix/pii-lifecycle` branch exists but is not presented as part of the verified production `main` state.

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

**Production deployed / operator acceptance-tested.**

This repository is a portfolio project demonstrating authenticated webhook ingestion, privacy-aware data processing, and Google Ads Enhanced Conversions integration. Public evidence is limited to sanitized source artifacts and documented verification results.
