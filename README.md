# Calenso Enhanced Conversions Pipeline

A privacy-conscious automation pipeline that connects Calenso appointment bookings with Google Ads Enhanced Conversions using n8n, Docker and Tailscale Funnel.

The project demonstrates a production-style integration architecture with webhook processing, data minimization, validation, normalization, SHA-256 hashing and server-side Google Ads API communication.

## Project Goal

The goal of this project is to build a secure, reusable and maintainable automation pipeline between Calenso and Google Ads.

The pipeline is designed to:

* Receive new Calenso appointment events through HTTPS webhooks
* Extract only the data required for conversion processing
* Validate incoming booking data
* Normalize customer identifiers
* Hash customer email identifiers using SHA-256
* Associate browser-side and server-side conversions using the same appointment UUID
* Upload Enhanced Conversion data to the Google Ads API
* Keep credentials and secrets outside the Git repository
* Provide a reproducible Docker-based environment

## Architecture

The integration consists of two related conversion paths.

```text
                           Calenso Booking
                                |
                 +--------------+--------------+
                 |                             |
                 | Browser                     | Webhook
                 v                             v
          Google Tag Manager            Tailscale Funnel
                 |                             |
                 v                             v
      Google Ads Conversion                  n8n
          transaction_id                     |
                 |                            v
                 |                     Data Minimization
                 |                            |
                 |                            v
                 |                        Validation
                 |                            |
                 |                            v
                 |                      Normalization
                 |                            |
                 |                            v
                 |                     SHA-256 Hashing
                 |                            |
                 |                            v
                 |                    Google Ads Payload
                 |                            |
                 |                            v
                 +------------------> Google Ads API
                           matching by
                        appointment UUID
```

The Calenso appointment UUID is used as:

```text
GTM transaction_id = n8n orderId
```

This allows the browser-side conversion and server-side Enhanced Conversion data to reference the same appointment.

## Verified End-to-End Flow

The following production flow has been successfully tested:

```text
Calenso
  |
  | appointment.booking.created
  v
Production Webhook
  |
  v
Minimize Conversion Data
  |
  v
Validate Conversion Data
  |
  v
Route Valid Conversion
  |
  v
Normalize Customer Identifiers
  |
  v
Hash Email Identifier
  |
  v
Prepare Google Ads Payload
  |
  v
Upload Enhanced Conversion
  |
  v
Google Ads API
```

A real test booking successfully reached the Google Ads API using an `ENHANCEMENT` conversion adjustment.

The appointment UUID was also verified to be identical between:

* Calenso booking
* GTM `appointment_uuid`
* Google Ads browser-side transaction ID
* n8n `orderId`

## Current Status

### Milestone 1 - Webhook Infrastructure ✅

Implemented:

* Dockerized n8n environment
* Persistent n8n storage
* Persistent Tailscale state
* Tailscale Funnel HTTPS endpoint
* Shared network namespace between n8n and Tailscale
* Public production webhook endpoint
* Calenso webhook integration

### Milestone 2 - Data Minimization ✅

Implemented:

* Processing of `appointment.booking.created`
* Extraction of required booking fields only
* Removal of unnecessary Calenso payload data before downstream processing
* Separation of customer identifiers from the complete webhook payload

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

### Milestone 3 - Validation & Normalization ✅

Implemented:

* Required-field validation
* Event-type validation
* Email-format validation
* Validation status routing
* Email trimming and lowercasing
* Gmail / Googlemail dot normalization
* Phone normalization
* Basic E.164 phone validation
* `REVIEW_REQUIRED` routing for invalid input

### Milestone 4 - Google Ads Integration ✅

Implemented:

* SHA-256 email hashing
* Google Ads OAuth 2.0 authentication
* Google Ads Developer Token via environment variable
* Google Ads Conversion Action integration
* Enhanced Conversion payload generation
* `ENHANCEMENT` conversion adjustment upload
* Appointment UUID used as `orderId`
* Conversion timestamp based on the Calenso booking event timestamp
* Successful Google Ads API response
* Verified GTM transaction ID / n8n order ID equality

### Milestone 5 - Logging & Error Handling 🚧

Planned:

* Invalid-event logging
* API failure handling
* Retry strategy
* Structured error output
* Review queue
* Failure notifications
* Execution monitoring

### Milestone 6 - Production Hardening 🚧

Planned:

* 24/7 server or VPS deployment
* Improved secret management
* Duplicate-processing protection
* Idempotency strategy
* Monitoring and health checks
* Backup strategy
* Workflow versioning
* Security review
* Data-protection review

## n8n Workflow

The current workflow follows a business-process pipeline pattern:

```text
Input
  |
  v
Minimize
  |
  v
Validate
  |
  v
Decision
  |
  v
Normalize
  |
  v
Hash
  |
  v
Prepare
  |
  v
External Action
```

Current nodes:

```text
Receive Calenso Booking
Minimize Conversion Data
Validate Conversion Data
Route Valid Conversion
Normalize Customer Identifiers
Hash Email Identifier
Prepare Google Ads Payload
Upload Enhanced Conversion
```

This design keeps responsibilities separated and makes the workflow easier to test, maintain and extend.

## Data Minimization

Calenso webhook payloads contain significantly more information than is required for conversion processing.

The workflow therefore reduces the incoming payload before additional processing.

Only fields required for validation, identification and conversion processing are retained.

Unnecessary customer, employee, service, business and internal platform metadata is not intentionally forwarded to Google Ads.

## Customer Identifier Processing

### Email

Email values are:

1. Trimmed
2. Converted to lowercase
3. Gmail / Googlemail dots normalized where applicable
4. SHA-256 hashed before being included in the Google Ads request

Example processing flow:

```text
Customer email
      |
      v
Normalization
      |
      v
SHA-256
      |
      v
Google Ads API
```

### Phone

Phone normalization and basic E.164 validation are implemented.

Phone hashing and transmission to Google Ads are not yet enabled in the current workflow version.

This will be added after the email-based integration has been fully stabilized.

## Google Ads Integration

The server-side workflow sends Enhanced Conversion adjustments through the Google Ads API.

The request uses:

```text
adjustmentType: ENHANCEMENT
orderId: Calenso appointment UUID
conversionAction: configured Google Ads conversion action
conversionDateTime: Calenso booking event timestamp
userIdentifierSource: FIRST_PARTY
hashedEmail: SHA-256 normalized email
```

Authentication uses OAuth 2.0.

The Google Ads Developer Token is injected into the n8n container through an environment variable and is not stored in the Git repository.

## Browser-Side Matching

Google Tag Manager receives the Calenso booking completion event from the website.

The Calenso appointment UUID is extracted into the GTM data layer and used as the Google Ads transaction ID.

Example concept:

```text
Calenso appointment UUID
        |
        +--------------------+
        |                    |
        v                    v
GTM transaction_id       n8n orderId
        |                    |
        +---------=----------+
```

This equality was verified during an end-to-end test.

## Security & Privacy

Security and privacy are design requirements of this project.

Current measures include:

* `.env` is excluded from Git
* `.env.example` contains placeholders only
* API secrets are not hard-coded in workflow files
* Google Ads Developer Token is provided through an environment variable
* OAuth credentials are managed by n8n credentials
* Customer identifiers are minimized before downstream processing
* Email identifiers are SHA-256 hashed before transmission
* No real customer execution data should be committed to the repository
* Incoming public webhook traffic uses HTTPS through Tailscale Funnel
* n8n and Tailscale state use separate persistent Docker volumes

> **Important:** This repository must never contain real customer data, authentication keys, OAuth secrets, API tokens or production credentials.

### Environment Variable Access

The current n8n environment allows workflow access to environment variables because the Google Ads Developer Token is referenced from the workflow.

This is acceptable for the current development architecture but should be reviewed as part of production hardening and secret-management improvements.

## Project Structure

```text
calenso-enhanced-conversions/
|
|-- docker-compose.yml
|-- .env                 # Local secrets - NOT committed
|-- .env.example         # Environment variable template
|-- .gitignore
|-- README.md
|
`-- workflows/
    `-- calenso-enhanced-conversions-pipeline.json
```

The workflow export will be updated as development milestones are completed.

## Environment Variables

Create a local `.env` file based on `.env.example`.

Example:

```env
TAILSCALE_AUTHKEY=your_tailscale_auth_key_here
GOOGLE_ADS_DEVELOPER_TOKEN=your_google_ads_developer_token_here
```

Never commit the real `.env` file.

## Running the Environment

Start the Docker environment:

```bash
docker compose up -d
```

Check running containers:

```bash
docker compose ps
```

View logs:

```bash
docker compose logs
```

Stop the environment:

```bash
docker compose down
```

Persistent volumes preserve n8n and Tailscale state across normal container restarts.

## Webhook Modes

n8n provides separate webhook URLs for testing and production.

Development testing:

```text
/webhook-test/...
```

Published workflow:

```text
/webhook/...
```

The Calenso production integration must use the `/webhook/` endpoint.

The workflow does not require the n8n editor or browser tab to remain open.

However, the Docker host must currently remain online because n8n and Tailscale are running locally.

A future production deployment will move the service to an always-on environment.

## Tech Stack

* Docker
* Docker Compose
* n8n
* Tailscale
* Tailscale Funnel
* Calenso Webhooks
* Google Tag Manager
* Google Ads
* Google Ads API
* OAuth 2.0
* SHA-256
* Git
* GitHub

## Engineering Principles

This project follows several principles commonly used in professional automation and integration projects:

* Reproducible infrastructure
* Separation of configuration and secrets
* Data minimization
* Input validation
* Normalized data structures
* Explicit decision logic
* Modular workflow design
* Environment-based configuration
* Version control
* Incremental development through milestones
* End-to-end testing
* Privacy-conscious system design

## Roadmap

```text
Milestone 1  Webhook Infrastructure           ✅
Milestone 2  Data Minimization                ✅
Milestone 3  Validation & Normalization       ✅
Milestone 4  Google Ads Integration           ✅
Milestone 5  Logging & Error Handling         🚧
Milestone 6  Production Hardening             🚧
```

Future improvements may include:

* Hashed phone identifier support
* Structured error workflow
* Retry handling
* Conversion deduplication
* Logging database
* Monitoring
* 24/7 deployment
* Automated workflow backups
* Additional documentation

## Disclaimer

This repository is an educational and portfolio project demonstrating automation architecture and integration patterns.

Successful API submission does not by itself guarantee that Google Ads will ultimately match every Enhanced Conversion to an existing browser-side conversion.

Production use requires appropriate security, privacy, GDPR/data-protection and platform-specific review.

No real patient or customer data should be committed to this repository.
