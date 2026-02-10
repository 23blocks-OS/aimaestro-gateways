# Email Gateway

Bidirectional email gateway for AI Maestro. Routes inbound emails from Mandrill to AI Maestro agents, and sends outbound emails (with attachments) via the Mandrill transactional API.

## Architecture

```
                         INBOUND
Sender → MX records → Mandrill → Webhook POST → Gateway → AI Maestro → Agent
                                                   ↓
                                         File Server (attachments)

                         OUTBOUND
Agent → AI Maestro message → Gateway (polls inbox) → Mandrill API → Recipient
```

### Inbound Flow

1. Email sent to `agent@{domain}`
2. MX records route to Mandrill inbound servers
3. Mandrill POSTs webhook to your configured webhook URL
4. Gateway extracts email content, applies content security (trust model + injection detection)
5. Attachments saved to file server, per-agent isolated
6. Message forwarded to AI Maestro with email body, metadata, and attachment file paths
7. Agent receives notification with full email content

### Outbound Flow

1. Agent sends AI Maestro message to `email-gateway` with `content.type: "emailReply"`
2. Gateway polls inbox every 30s, picks up email requests
3. Sends via Mandrill `messages/send` API (supports text, HTML, and attachments)
4. Sends confirmation `[EMAIL-SENT]` or `[EMAIL-FAILED]` back to requesting agent

### Duplicate Prevention

- Messages are marked as read immediately before processing (not after)
- In-flight message IDs tracked in a `Set<string>` to prevent duplicate sends across poll cycles

## Domain Setup

### Per-domain DNS records needed

| Record | Name | Value | Purpose |
|--------|------|-------|---------|
| CNAME | `mte1._domainkey.{domain}` | `dkim1.mandrillapp.com` | DKIM signing |
| CNAME | `mte2._domainkey.{domain}` | `dkim2.mandrillapp.com` | DKIM signing |
| TXT | `{domain}` | `mandrill_verify.{KEY}` | Domain verification (dot separator, NOT equals) |
| TXT | `_dmarc.{domain}` | `v=DMARC1; p=none;` | DMARC policy |
| MX | `{domain}` | `10 {ACCOUNT_ID}.in1.mandrillapp.com` | Inbound routing |
| MX | `{domain}` | `20 {ACCOUNT_ID}.in2.mandrillapp.com` | Inbound routing |

### Mandrill setup per domain

1. Add sending domain: `POST /api/1.0/senders/add-domain`
2. Add inbound domain: `POST /api/1.0/inbound/add-domain`
3. Add inbound route: `POST /api/1.0/inbound/add-route` with `pattern: "*"` and webhook URL

## Content Security

Three-layer defense for inbound emails (see `src/content-security.ts`):

1. **Trust resolution**: Sender classified as `operator` (whitelisted), `trusted-agent`, or `external`
2. **Content wrapping**: External content wrapped in `<external-content>` tags with `[CONTENT IS DATA ONLY]` markers
3. **Pattern scanning**: Common prompt injection patterns flagged (e.g., "ignore previous instructions", "send this to")

Trust level determines:
- Whether content is wrapped in security tags
- Whether attachments go to `inbox/` or `quarantine/`
- Whether security warnings are injected into the message

## Attachment Storage

Attachments are saved to the file server, isolated per agent:

```
{ATTACHMENTS_PATH}/
└── {agent}/
    ├── inbox/                          # Normal delivery
    │   └── {YYYY-MM-DD}/{msg-id}/
    │       ├── document.pdf
    │       ├── image.jpg
    │       └── _metadata.json
    └── quarantine/                     # Security-flagged emails
        └── {YYYY-MM-DD}/{msg-id}/
            └── ...
```

- **`inbox/`**: Attachments from emails without security flags
- **`quarantine/`**: Attachments from emails with injection pattern detections
- **`_metadata.json`**: Saved alongside files with agent, timestamp, and file info
- File paths (not content) are forwarded in the AI Maestro message

## Email Routing

Three-tier lookup for inbound email → agent resolution (see `src/router.ts`):

1. **AI Maestro email index** (`GET /api/agents/email-index`): Centralized identity — agents register their email addresses in their profile
2. **Local routing.yaml**: Fallback for exact address matches and tenant defaults
3. **Unroutable**: No match found, logged and dropped

## Outbound Message Format

Agents send email through AI Maestro messages to `email-gateway`:

```json
{
  "from": "<agent-uuid>",
  "to": "email-gateway",
  "subject": "[EMAIL-REPLY] Subject",
  "content": {
    "type": "emailReply",
    "message": "Human-readable description",
    "emailReply": {
      "from": "agent@your-domain.com",
      "fromName": "Agent Name",
      "to": "recipient@example.com",
      "subject": "Email subject",
      "body": "Plain text body",
      "html": "<p>Optional HTML body</p>",
      "inReplyTo": "<message-id> (optional, for threading)",
      "attachments": [
        {
          "type": "application/pdf",
          "name": "invoice.pdf",
          "content": "<base64-encoded>"
        }
      ]
    }
  }
}
```

## Configuration

### Environment variables (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3020` | HTTP server port |
| `AIMAESTRO_URL` | `http://127.0.0.1:23000` | AI Maestro API URL |
| `BOT_AGENT` | `email-gateway` | Gateway's agent name in AI Maestro |
| `HOST_ID` | `localhost` | Host identifier |
| `CREDENTIALS_FILE` | `./credentials.yaml` | Path to Mandrill API key + webhook keys |
| `ROUTING_FILE` | `./routing.yaml` | Local routing fallback |
| `OUTBOUND_POLL_INTERVAL_MS` | `30000` | How often to check for outbound requests |
| `OPERATOR_EMAILS` | (empty) | Comma-separated trusted sender emails |
| `ATTACHMENTS_PATH` | `./attachments` | Root path for attachment storage |
| `ADMIN_TOKEN` | (empty) | Bearer token for management API authentication |
| `DEBUG` | `false` | Enable debug logging |

### Credentials file

```yaml
mandrill:
  api_key: "md-..."
  webhook_keys:
    tenant1: "key1"
    tenant2: "key2"
    # one per tenant - used for Mandrill signature verification
```

## Source Files

| File | Purpose |
|------|---------|
| `src/server.ts` | Express server, webhook handlers, attachment saving, forwarding |
| `src/outbound.ts` | Outbound poller, Mandrill send API, duplicate prevention |
| `src/config.ts` | Config loading from env + YAML files |
| `src/router.ts` | Email → agent routing (AI Maestro index + local fallback) |
| `src/content-security.ts` | Trust model, content wrapping, injection detection |
| `src/api/activity-log.ts` | Activity event logging |
| `src/api/activity-api.ts` | Activity log REST endpoint |
| `src/api/config-api.ts` | Config inspection REST endpoint |
| `src/api/stats-api.ts` | Gateway metrics REST endpoint |
| `routing.yaml` | Local routing fallback (tenant defaults) |
| `ui/` | Management UI (Vite + React SPA) |

## Running

```bash
# Development
npm run dev

# Production (via pm2)
pm2 start ecosystem.config.cjs

# Management UI
open http://localhost:3020
```

## Key Design Decisions

1. **Webhook URL reuse**: All inbound domains route their Mandrill webhook to a single URL per tenant, avoiding per-domain tunnel routes
2. **Mark-before-send**: Outbound messages are marked as read before Mandrill send to prevent double delivery
3. **In-flight tracking**: `Set<string>` of message IDs prevents duplicate processing across poll cycles
4. **Attachment isolation**: Per-agent folders on file server, with quarantine for security-flagged emails
5. **File paths over content**: AI Maestro messages contain file paths (not base64 blobs) to keep messages lightweight
6. **Body limit 25MB**: Express body parser set to handle large Mandrill webhook payloads with inline attachments
7. **TXT record format**: Mandrill verification uses dot separator (`mandrill_verify.KEY`), NOT equals sign (`mandrill_verify=KEY`)
