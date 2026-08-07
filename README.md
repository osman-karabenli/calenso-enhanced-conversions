# Calenso Enhanced Conversions Pipeline

A privacy-conscious automation pipeline for receiving Calenso webhook events,
processing customer identifiers with n8n, and preparing conversion data for
Google Ads Enhanced Conversions.

> 🚧 This project is currently under development.

## Project Goal

The goal of this project is to build a secure, reusable and maintainable
automation pipeline between Calenso and Google Ads.

The pipeline is designed to:

- Receive Calenso events through webhooks
- Validate incoming webhook data
- Minimize personal data before further processing
- Normalize required customer identifiers
- Prepare identifiers for Google Ads Enhanced Conversions
- Keep secrets and credentials outside the Git repository
- Provide a reproducible Docker-based development environment

## Architecture

The current Proof of Concept uses the following architecture:

```text
Calenso
   │
   │ HTTPS Webhook
   ▼
Tailscale Funnel
   │
   ▼
Docker Environment
   │
   ├── Tailscale Sidecar
   │
   └── n8n
          │
          ▼
     Webhook Node
          │
          ▼
   Data Processing
```

The n8n and Tailscale containers share the same network namespace.

This allows Tailscale Funnel to proxy incoming HTTPS requests to the local
n8n service without exposing n8n directly through a traditional public port.

Persistent Docker volumes are used to preserve n8n and Tailscale state
across container restarts.

## Current Status

### Milestone 1 – Webhook Proof of Concept ✅

The first integration milestone has been completed successfully.

Implemented:

- Dockerized n8n environment
- Persistent n8n storage
- Tailscale container with persistent state
- Tailscale Funnel public HTTPS endpoint
- Shared network namespace between n8n and Tailscale
- Calenso webhook endpoint in n8n
- Successfully received `customer.created` events from Calenso
- Verified that customer identifiers required for further processing are
  available in the webhook payload

### Milestone 2 – Data Processing 🚧

Next steps:

- Extract only required customer identifiers
- Remove unnecessary personal data
- Validate incoming webhook data
- Normalize email and phone values
- Prepare identifiers for secure downstream processing
- Prepare the Google Ads Enhanced Conversions integration

### Planned Milestones

```text
Milestone 1  Webhook Proof of Concept       ✅
Milestone 2  Data Minimization              🚧
Milestone 3  Validation & Normalization
Milestone 4  Google Ads Integration
Milestone 5  Logging & Error Handling
Milestone 6  Production Hardening
```

## Data Minimization

Calenso webhook payloads can contain significantly more information than
is required for conversion processing.

The pipeline is therefore designed around the principle of data minimization.

Instead of forwarding the complete webhook payload, the processing layer will
extract only the identifiers required for the intended conversion workflow.

Unnecessary customer, employee, appointment, business and internal platform
metadata will not be forwarded to downstream systems.

## Security & Privacy

Security and privacy are design requirements of this project.

Current measures include:

- Secrets are stored using environment variables
- The `.env` file is excluded from Git
- `.env.example` contains placeholders only
- No real customer webhook payloads are committed to the repository
- n8n data is stored in a persistent Docker volume
- Tailscale state is stored separately
- Incoming public traffic uses HTTPS through Tailscale Funnel
- Data minimization is performed before downstream processing

Future development will include additional validation and error-handling
mechanisms before data is sent to external services.

> **Important:** This repository must never contain real customer data,
> authentication keys, API secrets or production credentials.

## Project Structure

```text
calenso-enhanced-conversions/
│
├── docker-compose.yml
├── .env                 # Local secrets - NOT committed
├── .env.example         # Environment variable template
├── .gitignore
├── README.md
│
└── workflows/
    └── calenso-customer-webhook-poc.json
```

## Environment Variables

Create a local `.env` file based on `.env.example`.

Example:

```env
TAILSCALE_AUTHKEY=your_tailscale_auth_key_here
```

Never commit the real `.env` file.

## Running the Development Environment

Start the Docker environment with:

```bash
docker compose up
```

The local n8n interface is available through the port configured in
`docker-compose.yml`.

The public webhook endpoint is provided through Tailscale Funnel.

## Workflow

The current n8n Proof of Concept contains a webhook node configured to receive
Calenso HTTP POST events.

Workflow export:

```text
workflows/calenso-customer-webhook-poc.json
```

The exported workflow intentionally contains no customer execution data or
credentials.

## Tech Stack

- Docker
- Docker Compose
- n8n
- Tailscale
- Tailscale Funnel
- Calenso Webhooks
- Google Ads Enhanced Conversions (planned integration)
- Git
- GitHub

## Engineering Principles

This project follows several principles commonly used in automation and
integration projects:

- Reproducible infrastructure
- Separation of configuration and secrets
- Data minimization
- Explicit validation
- Normalized data structures
- Modular workflow design
- Version control
- Incremental development through milestones

## Disclaimer

This repository is an educational and portfolio project demonstrating
automation architecture and integration patterns.

No real patient or customer data should be stored in the repository.
Production use requires an appropriate review of security, privacy,
data-protection and platform-specific requirements.