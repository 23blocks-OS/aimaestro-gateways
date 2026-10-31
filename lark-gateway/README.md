# Lark Gateway

Connects a Lark or Feishu bot to AI Maestro over AMP. It uses Lark's persistent long connection, so the gateway does not need a public webhook URL. Direct messages are routed through a provisioning-owned `routing.yaml`; group messages are ignored unless the bot is explicitly mentioned, in which case the bot sends only the configured pointer line.

The gateway is tested with fake events. It has not yet been run against a live Lark app; use the smoke procedure below after creating one.

## Lark Developer Console setup

1. Create a custom app in the [Lark Developer Console](https://open.larksuite.com/app) (use the Feishu Open Platform for a Feishu tenant). Enable the **Bot** capability and set the bot name and avatar.
2. In **Permissions & Scopes**, enable these tenant permissions:

   | Scope | Used for |
   |---|---|
   | `im:message` | Receive messages and read message content |
   | `im:message:send_as_bot` | Send text, cards, and file/image messages as the bot |
   | `im:message.p2p_msg:readonly` | Receive direct messages to the bot |
   | `im:message.group_at_msg:readonly` | Receive group messages that mention the bot |
   | `im:message:readonly` | Fetch parent message text and message resources |
   | `im:resource` | Download user-sent message resources |
   | `im:resource:upload` | Upload agent reply attachments |
   | `im:message.reactions:write_only` | Add and remove progress reactions |
   | `im:message.reactions:read` | Find the bot's progress reaction so it can be removed |

   The Lark UI may show both a human name and the scope ID; search by the exact ID above. Some tenants may not offer granular `p2p_msg` or `group_at_msg` entries; in that case enable the equivalent receive-message permissions shown for the app and keep the event selection below restricted to the required event.

3. Under **Events & Callbacks → Event Configuration**, select **Receive events through persistent connection**. Add **Receive message** (`im.message.receive_v1`). The gateway receives message events on `WSClient`.
4. Under **Events & Callbacks → Callback Configuration**, enable interactive card callbacks and add `card.action.trigger`. Set the callback request URL to your HTTPS reverse proxy URL ending in `/lark/callback` (for example `https://gateway.example.invalid/lark/callback`). Add the verification token to `.env` as `LARK_VERIFICATION_TOKEN`; if the Console encrypts callbacks, also set its encryption key as `LARK_ENCRYPT_KEY`. **Card action callbacks use HTTP:** SDK 1.76.0's WebSocket client discards `card` frames before dispatching them, so registering the event on the long connection does not work. The HTTP endpoint uses the SDK `adaptExpress` validator and replies to clicks immediately; the agent request runs asynchronously.
5. The gateway's management server follows the bind-address convention: it listens on `127.0.0.1` by default. To receive card callbacks from Lark, configure an HTTPS reverse proxy that forwards `/lark/callback` to the local service port. In Docker, compose publishes the port on host loopback; a host reverse proxy can forward to `127.0.0.1:3025`. Set `BIND_ADDRESS` only when your deployment requires the gateway itself to listen on another interface, and set `ADMIN_TOKEN` before exposing management routes.
6. Save changes, create a version, and publish it to the intended test users. A draft app version will not receive production events. Add the bot to your test users' available range.
7. Copy the app ID and app secret to `.env` as `LARK_APP_ID` and `LARK_APP_SECRET`. Keep the secret private.

Scopes depend on the tenant's Console catalog and the APIs it exposes. If a call returns a missing-scope message, grant the scope named in the Lark response, publish a new version, and restart the gateway.

## Run

```bash
cd lark-gateway
npm ci
cp .env.example .env
cp routing.example.yaml routing.yaml
# Edit .env and routing.yaml; publish your app version in Lark first.
npm start
```

Register a bridge agent with AI Maestro and set `AMP_API_KEY`, `AMP_AGENT_ADDRESS`, `AMP_TENANT`, and `AMP_INBOX_DIR`. Alternatively, set `AMP_AUTO_REGISTER=true`; the gateway registers `AMP_AGENT_NAME` and persists the resulting AMP values to `.env`. AI Maestro tenant discovery follows the same `/api/organization` fallback as the other gateways.

Without Lark or AMP credentials the process stays alive in **health-only mode**, prints one actionable configuration error, and serves `/health`; it does not repeatedly crash under Docker or pm2.

## Routing and trust

`routing.yaml` is written by the provisioning system and hot-reloaded when changed. It follows C5:

```yaml
tenant: example
default_reply_unknown: "This bot is not configured for your account."
disabled_person: "Your agent is paused. Please contact an administrator."
group_pointer: "Please DM this bot to reach your AI Maestro agent."
people:
  alice:
    open_id: ou_example_alice
    agent: alice
    enabled: true
    admin: false
```

`open_id` belongs only in this file and the local gateway state. The gateway sends the person's slug (`alice`) as `context.channel.sender_id` and `context.lark.person`; no `open_id` is sent to an agent. The Lark chat ID is included in `context.lark.chat_id` so AMP replies can return to that conversation.

The configured person route wins for ordinary DMs. Replies to a stored parent message stay with that thread's agent. An administrator may use `@AIM:agent-name` to explicitly select another agent; the alternate target receives externally wrapped content because the sender does not own that agent. Unknown and disabled people get the configured response and are not routed. In groups, unmentioned messages are ignored and a bot mention gets only `group_pointer`.

Messages from a person assigned to the target agent are operator-trusted. Other messages are scanned and wrapped in `<external-content>`. Forwarded (`merge_forward`) content is always wrapped as external data, including when its sender is an operator. Lark text normalization strips bot mention tokens, expands `post` text and inline images, records image/file/audio attachments, ignores stickers, and includes parent message text when available.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `LARK_APP_ID`, `LARK_APP_SECRET` | empty | Lark app credentials |
| `LARK_DOMAIN` | `lark` | `lark` or `feishu` API domain |
| `LARK_VERIFICATION_TOKEN` | empty | Required HTTP card callback validation token |
| `LARK_ENCRYPT_KEY` | empty | Callback decryption key when callback encryption is enabled |
| `LARK_ROUTING_FILE` | `./routing.yaml` | Sender-to-agent mapping |
| `AMP_MAESTRO_URL` | `http://127.0.0.1:23000` | AI Maestro API |
| `AMP_API_KEY` | empty | AMP bridge token; required unless auto-registration enabled |
| `AMP_AUTO_REGISTER` | `false` | Register the bridge with AI Maestro on startup |
| `AMP_AGENT_NAME` | `lark-bot` | Bridge agent name |
| `AMP_DEFAULT_AGENT` | `default-agent` | Compatibility fallback |
| `AMP_TENANT` | discovered / `default` | AMP tenant override |
| `AMP_INBOX_DIR` | agent home inbox | AMP outbound inbox |
| `STATE_DIR` | `./data` | Durable inbound queue, dedupe and thread stores |
| `PORT` | `3025` | Management API port |
| `BIND_ADDRESS` (`HOST`) | `127.0.0.1` | Management API bind address |
| `ADMIN_TOKEN` | empty | Bearer token for management API; required for `/api/*` |
| `POLL_INTERVAL_MS` | `3000` | AMP inbox poll interval |
| `POLL_TIMEOUT_MS` | `15000` | AMP route timeout |
| `WORKING_DELAY_MS` | `30000` | Delay before one “Still working on it.” reply |

`GET /health` is public. `GET /api/config`, `/api/stats`, and `/api/activity` require `Authorization: Bearer $ADMIN_TOKEN`. `/api/stats` is the Prometheus-style stats fallback used by this gateway; no separate `/metrics` endpoint is provided.

## Limits and delivery

Inbound attachments are downloaded through the message-resource API and base64-encoded in AMP attachments. The gateway accepts at most 10 attachments of at most 25 MB each; messages over either limit receive a clear reply and are not routed. Outbound files and images are uploaded through Lark's resource APIs. Structured Markdown (headings, lists, tables, links) is sent as an interactive card; simple text stays plain text. Long text is split into chunks below the Lark limits. AMP buttons become card buttons carrying the agent, action, value, owner slug, and AMP thread reference.

The inbound event is durably queued before acknowledgement. Event and message IDs are deduplicated on disk for 24 hours. Thread context survives restarts. Outbound delivery retries with exponential backoff and parks aged, repeatedly failing messages in the sibling `undeliverable/` directory.

## Docker

Copy `routing.example.yaml` to `routing.yaml`, configure `.env`, then run `docker compose up -d lark-gateway`. Compose publishes `127.0.0.1:3025` and mounts the host `~/.agent-messaging` directory into the container so the outbound AMP inbox can be read and consumed. The image binds inside its container to `0.0.0.0`; keep the host port mapping loopback-only unless intentionally exposing the management API with `ADMIN_TOKEN` set.

## Live smoke procedure

This procedure needs a published Lark app, real app credentials, a running AI Maestro instance, and one test person in `routing.yaml`.

1. Start the gateway and check `curl -fsS http://127.0.0.1:3025/health`; verify `configured: true` and that the long-connection log says ready.
2. DM the bot from the configured person and send `smoke text`. Verify one AMP route reaches that person's configured agent and the agent reply appears as a reply in the same DM.
3. Send a small PDF or image. Verify the agent receives one AMP attachment with the correct filename/content type, then ask the agent to return a small image/file and verify Lark receives it.
4. Ask the agent to send a structured Markdown response with a button, for example an `Approve` button whose value is `{"approved":true}`. Click it as the card owner and verify an AMP request arrives with `context.lark.card_action`; verify the agent's next reply lands in the same DM. Repeat with a different configured person and verify Lark returns the owner-only refusal toast and no AMP request.
5. Send a DM from an unknown account and a message in a group without mentioning the bot. Verify the configured unknown response and silence respectively; mention the bot in a group and verify only the pointer line is sent.

Record the Lark app release, gateway version, the checks above, and any scope errors before treating the live integration as accepted. Fake fixtures cover normal CI; live Lark tests cannot run without an app.
