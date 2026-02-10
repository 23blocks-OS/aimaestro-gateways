# Slack Gateway

Slack connector for AI Maestro. Bridges Slack workspaces with AI Maestro agents using the Bolt SDK and Socket Mode.

## Features

- DM handling (routes to default agent)
- @mention detection in channels
- `@AIM:agent-name` routing syntax for multi-agent support
- Thread-aware conversations
- Multi-host agent resolution with caching
- Content security (trust model + injection pattern scanning)
- Management APIs (health, config, stats, activity log)
- Admin token authentication
- Multi-instance support (run multiple bots from one codebase)

## Quick Start

```bash
cp .env.example .env
# Edit .env with your Slack tokens
npm install
npm run dev
```

## Prerequisites

1. Create a Slack App at https://api.slack.com/apps
2. Enable Socket Mode and generate an App-Level Token (`xapp-...`)
3. Install the app to your workspace and get the Bot Token (`xoxb-...`)
4. Subscribe to events: `message.im`, `app_mention`, `message.channels`

## Configuration

See `.env.example` for all available environment variables.

## Message Flow

### Inbound (Slack → Agent)
1. User sends DM or @mentions the bot
2. Gateway resolves target agent (default or `@AIM:agent-name`)
3. Content security applied (trust assessment + injection scanning)
4. Message forwarded to AI Maestro with Slack context (channel, thread_ts)

### Outbound (Agent → Slack)
1. Agent sends response via AI Maestro
2. Gateway polls inbox, picks up responses
3. Replies sent to the originating Slack thread

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check with Slack connection status |
| `/api/config` | GET | Yes | Current gateway configuration |
| `/api/config/security` | PATCH | Yes | Update operator Slack IDs |
| `/api/stats` | GET | Yes | Gateway metrics and uptime |
| `/api/activity` | GET | Yes | Recent activity log |

## Running with pm2

```bash
pm2 start ecosystem.config.cjs
pm2 logs slack-gateway
```
