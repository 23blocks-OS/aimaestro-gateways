# WhatsApp Gateway - Architecture Design

**Status:** Draft

## Summary

A WhatsApp connector service for AI Maestro that bridges WhatsApp messaging with AI agents. Follows the same architectural pattern as the email gateway: a standalone Node.js service that translates between an external messaging platform and the AI Maestro message bus.

## Goals

1. Agents can receive WhatsApp messages as AI Maestro messages
2. Agents can send WhatsApp messages by posting to AI Maestro
3. Multi-account support (multiple WhatsApp numbers)
4. DM access control (allowlist, pairing, or open)
5. Group message support with mention-gating
6. Media handling (images, audio, video, documents)
7. Content security (injection scanning, trust wrapping)
8. Runs as a pm2 service

## Non-Goals (v1)

- End-to-end encryption between agents (handled by AMP layer)
- WhatsApp Business API integration (Baileys only for now)
- Voice call handling
- Status/story interactions

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     WhatsApp (Meta servers)                     │
└─────────────────────────────┬───────────────────────────────────┘
                              │ WhatsApp Web Protocol
                              │ (Signal Protocol / Noise)
                              │
                     ┌────────┴────────┐
                     │    Baileys      │  @whiskeysockets/baileys
                     │  (WA Web SDK)   │  Multi-device, linked device
                     └────────┬────────┘
                              │
                 ┌────────────┴────────────────┐
                 │     WhatsApp Gateway        │  Port 3021 (HTTP + WS)
                 │                             │
                 │  ┌─────────┐ ┌───────────┐  │
                 │  │ Inbound │ │ Outbound  │  │
                 │  │ Handler │ │ Poller    │  │
                 │  └────┬────┘ └─────┬─────┘  │
                 │       │            │        │
                 │  ┌────┴────────────┴────┐   │
                 │  │    Router            │   │
                 │  │  (phone → agent)     │   │
                 │  └────┬────────────┬────┘   │
                 │       │            │        │
                 │  ┌────┴────┐ ┌────┴─────┐  │
                 │  │ Content │ │ Media    │  │
                 │  │Security │ │ Handler  │  │
                 │  └─────────┘ └──────────┘  │
                 └────────────┬────────────────┘
                              │
                     ┌────────┴────────┐
                     │   AI Maestro    │
                     │   Message Bus   │
                     └────────┬────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
         ┌────┴────┐   ┌─────┴────┐   ┌──────┴──────┐
         │ default │   │ other    │   │ other       │
         │ agent   │   │ agents   │   │ agents      │
         └─────────┘   └──────────┘   └─────────────┘
```

## Technology Stack

| Component | Technology | Notes |
|-----------|-----------|-------|
| Runtime | Node.js 22+ | Same as email gateway |
| Language | TypeScript | Same as email gateway |
| WhatsApp SDK | @whiskeysockets/baileys | Unofficial WhatsApp Web multi-device API |
| HTTP Server | Express | Management API, health checks |
| Process Manager | pm2 | Same as other services |
| QR Code | qrcode-terminal | For linked device login |

## Connection Method: Baileys (WhatsApp Web)

### Why Baileys, Not WhatsApp Business API

| Factor | Baileys (chosen) | WhatsApp Business API |
|--------|------------------|-----------------------|
| 24h reply window | No restriction | Must reply within 24h or use templates |
| Message templates | Not required | Required for outbound after 24h |
| Cost | Free | Per-conversation pricing |
| Setup | QR code link | Meta Business verification |
| Personal assistant use | Ideal | Designed for businesses |
| Stability | Unofficial, can break | Official, stable |
| Rate limits | WhatsApp's standard | Template-based limits |

### Baileys Session Management

```
~/.whatsapp-gateway/
├── credentials/
│   ├── default/          # Default account auth state
│   │   ├── creds.json    # Signal protocol credentials
│   │   ├── creds.json.bak
│   │   └── ...           # Multi-file auth state (Baileys)
│   └── <accountId>/      # Additional accounts
│       └── ...
├── media/
│   ├── inbound/          # Downloaded media files
│   │   └── <date>/<msgId>/
│   └── outbound/         # Staged outbound media
└── config.json           # Gateway configuration
```

### Login Flow

```
1. Run: whatsapp-gateway login [--account <id>]
2. QR code displayed in terminal
3. User scans with WhatsApp → Settings → Linked Devices
4. Baileys stores auth state to credentials/<accountId>/
5. Connection maintained via WebSocket to WhatsApp servers
6. Auto-reconnect on disconnection (backoff: 1s → 30s → 60s)
```

## Message Flow

### Inbound (WhatsApp → Agent)

```
WhatsApp User sends message
        │
        ↓
Baileys fires "messages.upsert" event
        │
        ↓
Filter:
  - Ignore status/broadcast
  - Ignore messages from self (unless selfChatMode)
  - Check DM policy (allowlist/pairing/open)
        │
        ↓
Extract content:
  - Text body
  - Quoted reply context
  - Media: download + save to media/inbound/<date>/<msgId>/
        │
        ↓
Content Security:
  - Trust assessment (operator phone? → trusted, else → external)
  - Injection pattern scanning
  - Wrap external content in <external-content> tags
        │
        ↓
Route:
  - Lookup phone → agent mapping (routing config)
  - Fallback to default agent
        │
        ↓
Deliver to AI Maestro:
  POST /api/messages
```

### Outbound (Agent → WhatsApp)

```
Agent sends AI Maestro message to whatsapp-gateway
        │
        ↓
Outbound Poller (every 5 seconds):
  GET /api/messages?agent=whatsapp-gateway&box=inbox&status=unread
        │
        ↓
Filter: content.type === "whatsappSend"
        │
        ↓
Mark as read (prevent duplicate pickup)
        │
        ↓
Normalize target:
  - E.164 → strip + prefix, validate
  - Group JID → validate format
        │
        ↓
Send via Baileys:
  - Text: sock.sendMessage(jid, { text: "..." })
  - Image: sock.sendMessage(jid, { image: buffer, caption: "..." })
  - Audio: sock.sendMessage(jid, { audio: buffer, ptt: true })
  - Document: sock.sendMessage(jid, { document: buffer, fileName: "..." })
        │
        ├─→ Success: confirm to requesting agent
        └─→ Failure: error to requesting agent
```

## Configuration

### Environment Variables (.env)

```env
PORT=3021
AIMAESTRO_URL=http://127.0.0.1:23000
BOT_AGENT=whatsapp-gateway
HOST_ID=localhost
STATE_DIR=~/.whatsapp-gateway
OUTBOUND_POLL_INTERVAL_MS=5000
OPERATOR_PHONES=+1234567890
ADMIN_TOKEN=your-secret-token
DEBUG=false
```

### DM Policies

| Policy | Behavior |
|--------|----------|
| `allowlist` | Only phones in `allowFrom` can message. Others get no response. |
| `pairing` | Unknown senders get a pairing code. Approved senders added to allowlist. |
| `open` | Anyone can message (use with caution). |
| `disabled` | No DMs accepted. |

## Source File Structure

```
whatsapp-gateway/
├── package.json
├── tsconfig.json
├── .env.example
├── ARCHITECTURE.md
├── src/
│   ├── server.ts           # Express server, health API, management endpoints
│   ├── session.ts          # Baileys socket creation, auth state, reconnection
│   ├── inbound.ts          # WhatsApp message listener, event processing
│   ├── outbound.ts         # AI Maestro poller, Baileys send
│   ├── router.ts           # Phone → agent routing
│   ├── normalize.ts        # E.164 normalization, JID handling
│   ├── content-security.ts # Trust assessment, injection scanning
│   ├── config.ts           # Configuration loading
│   └── types.ts            # TypeScript type definitions
├── routing.yaml            # Phone → agent routing rules
└── scripts/
    └── login.ts            # CLI login helper
```

## Key Design Decisions

### 1. Separate Service (not embedded in email gateway)

WhatsApp has its own persistent connection (Baileys WebSocket), reconnection logic, and session state. Mixing it with the email gateway's webhook model would create unnecessary complexity. Separate services allow independent scaling, restarts, and debugging.

### 2. Polling for Outbound (same as email gateway)

Rather than WebSocket subscription from AI Maestro, we poll for outbound requests. This matches the email gateway pattern and keeps the gateway stateless relative to AI Maestro. Poll interval is 5 seconds (faster than email's 30s because WhatsApp users expect quicker responses).

### 3. Baileys Over WhatsApp Business API

For a personal assistant use case, Baileys is the right choice. No 24-hour window, no template requirements, no Meta Business verification. The tradeoff is that it's unofficial and could break, but the community maintains it actively.

### 4. Content Security Reuse

We reuse the same content security patterns from the email gateway (injection scanning, trust levels, `<external-content>` wrapping). The implementation can share the core scanning library.

### 5. Media Storage

Inbound media files are saved to a configurable path (`ATTACHMENTS_PATH`) for cross-machine access, same pattern as email attachments.

## Security Considerations

- **Phone number as identity:** WhatsApp uses E.164 phone numbers. We map these to trust levels via the operator phones list and routing config.
- **Injection defense:** All inbound messages from non-operator phones are wrapped in `<external-content>` tags with injection scanning.
- **Credential protection:** Baileys auth state (`creds.json`) contains Signal protocol keys. File permissions must be 0600. Never commit to git.
- **Rate limiting:** WhatsApp itself rate-limits. The gateway adds rate limiting on outbound messages per account.

## Implementation Phases

### Phase 1: Core (MVP)

- Baileys session management (login, reconnect, logout)
- Inbound DM handling (allowlist policy)
- Outbound text messages
- AI Maestro integration (inbound notifications, outbound polling)
- Basic content security
- pm2 service setup

### Phase 2: Media + Groups

- Inbound media download and storage
- Outbound media (image, audio, document)
- Group message support with mention-gating
- Quoted message threading

### Phase 3: Polish

- Pairing flow for unknown senders
- Multi-account support
- Ack reactions
- Management API (health, status, routing)
- Read receipts control

## Dependencies

```json
{
  "@whiskeysockets/baileys": "^6.x",
  "express": "^4.x",
  "qrcode-terminal": "^0.12.x",
  "pino": "^8.x",
  "dotenv": "^16.x"
}
```

## Service Management

```bash
# Start
pm2 start ecosystem.config.cjs

# Login (interactive - requires terminal)
npx tsx scripts/login.ts

# Check status
pm2 status whatsapp-gateway

# View logs
pm2 logs whatsapp-gateway

# Restart
pm2 restart whatsapp-gateway
```
