# Discord Gateway

Discord connector for AI Maestro. Routes Discord messages (DMs and @mentions) to AI Maestro agents, and delivers agent responses back to Discord channels.

## Features

- DM handling (routes to default agent)
- @mention detection in guild channels
- `@AIM:agent-name` routing syntax for multi-agent support
- Thread support
- 2000-character message splitting for long responses
- Typing indicators while waiting for agent responses
- Content security (trust model + injection pattern scanning)
- Management APIs (health, config, stats, activity log)
- Admin token authentication

## Quick Start

```bash
cp .env.example .env
# Edit .env with your Discord bot token
npm install
npm run dev
```

## Prerequisites

1. Create a Discord Application at https://discord.com/developers/applications
2. Create a Bot and copy the token
3. Enable **Message Content Intent** in Bot settings
4. Invite the bot to your server with permissions: Send Messages, Read Messages, Add Reactions

## Configuration

See `.env.example` for all available environment variables.

## Message Flow

### Inbound (Discord → Agent)
1. User sends DM or @mentions the bot
2. Gateway applies content security (trust assessment + injection scanning)
3. Message forwarded to AI Maestro with Discord context (channelId, messageId)
4. Target agent receives the message

### Outbound (Agent → Discord)
1. Agent sends response via AI Maestro
2. Gateway polls inbox, picks up responses
3. Replies sent to the originating Discord channel/thread
4. Long responses split at 2000-character boundaries

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Health check with Discord connection status |
| `/api/config` | GET | Yes | Current gateway configuration |
| `/api/config/security` | PATCH | Yes | Update operator Discord IDs |
| `/api/stats` | GET | Yes | Gateway metrics and uptime |
| `/api/activity` | GET | Yes | Recent activity log |

## Running with pm2

```bash
pm2 start ecosystem.config.cjs
pm2 logs discord-gateway
```
