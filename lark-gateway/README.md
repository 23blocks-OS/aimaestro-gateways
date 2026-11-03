# Lark Gateway

Connects a Lark or Feishu bot to AI Maestro over AMP. It uses Lark's persistent long connection, so the gateway does not need a public webhook URL. Direct messages are routed through a provisioning-owned `routing.yaml`; group messages are ignored unless the bot is explicitly mentioned, in which case the bot sends only the configured pointer line.

The gateway has been run against a live Lark app (a Lark test company, AI Maestro v0.106.40). Verified live: DM routing both ways, the "Still working on it." line, Markdown cards with headings, tables and code blocks, card buttons and their click toast, quoted replies, combined forwards, inbound and outbound images and files, the group pointer, and parking of replies from agents that do not own the conversation. Not yet verified live: a card click by a non-owner, unknown and disabled senders, and restarts with messages in flight (these are covered by the fake-event tests). Use the smoke procedure below on your own app.

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
   | `im:resource` | Download user-sent message resources and upload agent reply attachments |
   | `im:message.reactions:write_only` | Add and remove progress reactions |
   | `im:message.reactions:read` | Find the bot's progress reaction so it can be removed |

   The Lark UI may show both a human name and the scope ID; search by the exact ID above. There is no separate upload scope; `im:resource` covers it. Some tenants may not offer granular `p2p_msg` or `group_at_msg` entries; in that case enable the equivalent receive-message permissions shown for the app and keep the event selection below restricted to the required event.

3. Under **Events & Callbacks → Event Configuration**, select **Receive events through persistent connection**. Add **Receive message** (`im.message.receive_v1`). The gateway receives message events on `WSClient`. The Console only saves the persistent-connection choice while a client is connected, so start the gateway with the app credentials first, then save.
4. Under **Events & Callbacks → Callback Configuration**, choose **receive callbacks through persistent connection** and add `card.action.trigger` (not the legacy card callback). Keep the gateway's default `LARK_CARD_CALLBACK_MODE=long-connection`; both `im.message.receive_v1` and card actions are handled by the same SDK `EventDispatcher` on the private long connection. The SDK's Channel implementation registers `card.action.trigger` on this dispatcher. No public ingress or `LARK_VERIFICATION_TOKEN` is needed in this mode.
5. For legacy deployments that deliver callbacks through a webhook, set `LARK_CARD_CALLBACK_MODE=http`, configure an HTTPS reverse proxy URL ending in `/lark/callback`, and set `LARK_VERIFICATION_TOKEN` (plus `LARK_ENCRYPT_KEY` if Console callback encryption is enabled). HTTP callbacks use the SDK `CardActionHandler` and respond before the agent request runs. The endpoint follows the normal bind-address rules; Docker publishes loopback by default, and a host reverse proxy can forward to `127.0.0.1:3025`.
6. Save changes, create a version, and publish it to the intended test users. A draft app version will not receive production events. Add the bot to your test users' available range. To test without waiting for a tenant administrator to approve each version, create a Lark **test company** from the Developer Console and install the app there: changes apply immediately (the test company has a monthly API call quota).
7. Each person's `open_id` for `routing.yaml` is specific to this app: the same person has a different `open_id` under every Lark app. Resolve it with this app's credentials (for example, the contact API by email); never copy an `open_id` from another app.
8. Copy the app ID and app secret to `.env` as `LARK_APP_ID` and `LARK_APP_SECRET`. Keep the secret private.
9. The management server listens on `127.0.0.1` by default. Set `BIND_ADDRESS` only when the service itself needs another interface, and set `ADMIN_TOKEN` before exposing management routes.

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

`open_id` belongs only in this file and the local gateway state. The gateway sends the person's slug (`alice`) as `context.channel.sender_id` and `context.lark.person`; no `open_id` is sent to an agent. The DM's chat ID (`oc_…`) and the Lark message IDs are included in `context.channel` and `context.lark` so an agent can refer to the conversation; they carry no personal identifier, though a DM chat ID maps to one person for this app. The private thread store maps AMP replies back to the Lark conversation.

The configured person route wins for ordinary DMs. Replies to a stored parent message stay with that thread's agent. An administrator may use `@AIM:agent-name` to explicitly select another agent; non-admin tags do not override routing. The alternate target receives externally wrapped content because the sender does not own that agent. Unknown and disabled people get the configured response and are not routed. In groups, unmentioned messages are ignored and a bot mention gets only `group_pointer`.

Messages from a person assigned to the target agent are operator-trusted. Other messages are scanned and wrapped in `<external-content>`. Forwarded (`merge_forward`) content is always wrapped as external data, including when its sender is an operator. Lark text normalization strips bot mention tokens, expands `post` text and inline images, records image/file/audio attachments, ignores stickers, and keeps line breaks. Forwarded messages are expanded one per line with continuation lines indented, and an `@AIM:` tag inside forwarded content never selects an agent. When a message quotes another, the quoted text is added as `context.lark.parent_text`, wrapped as external data and labelled with its author: `agent` for a bot message, the person's slug for their own message, or `other-lark-user`. Lark's message API does not return the text of Card JSON 2.0 cards, so quoting one of the agent's cards gives `[card; Lark does not return its text]`; the reply still routes to that thread's agent.

Outbound delivery is owner-checked. A reply to a stored Lark thread is accepted only from the exact AMP agent recorded on that thread. An agent-initiated DM using `context.lark.to` is accepted only from the agent configured for that person in `routing.yaml`, compared by full AMP address (agent name plus tenant). Unauthorized or unresolved messages are parked in `undeliverable/`, each with a `<name>.reason.json` sidecar recording why; the gateway never lets one agent message another person's Lark DM. A failure notice ("could not be delivered") goes only to the conversation the sender had already been authorized for, once per parked message; a message parked before that check sends nothing, so an agent cannot use the notice to reach a person it does not serve.

AMP inbox files are read from sender-owned subdirectories, but AI Maestro's public AMP address lookup does not expose a sender public key for signature verification. The gateway therefore secures its inbox directory with mode `0700`; run it as a dedicated OS user or container with its own inbox volume, and do not share that writable inbox with untrusted processes. This filesystem trust limitation is shared by the sibling gateways.

## Delivery guarantees

Inbound Lark events are written to a local durable queue before the callback is acknowledged. On restart, queued events are retried. AI Maestro's current `POST /api/v1/route` contract does not accept an idempotency key (verified in `AMPRouteRequest` and `routeMessage`), so there is an at-least-once window: if Maestro accepts a route but the gateway is stopped before it receives and persists the returned AMP message ID, restart resubmits the same Lark message. In that interval the agent may see duplicate work or produce multiple replies; the Lark message ID in `context.lark.message_id` lets replies resolve to the original DM even before a route ID is known, and outbound part checkpoints prevent repeat sends after a part has been recorded as sent.

The in-flight restart soak exercises this boundary with 100 DMs from five senders: the fake Maestro accepted 101 route calls for 100 logical messages (one acceptance-window duplicate), all 100 replies were delivered once to their respective DMs, and none were lost or parked. The fake agent emits only one reply for each stable Lark message ID; the duplicate route acceptance is counted separately and does not prove agents themselves deduplicate repeated work.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `LARK_APP_ID`, `LARK_APP_SECRET` | empty | Lark app credentials |
| `LARK_DOMAIN` | `lark` | `lark` or `feishu` API domain |
| `LARK_CARD_CALLBACK_MODE` | `long-connection` | `long-connection` (private WS) or `http` (legacy `/lark/callback`) |
| `LARK_VERIFICATION_TOKEN` | empty | Required only in HTTP callback mode |
| `LARK_ENCRYPT_KEY` | empty | HTTP callback decryption key when encryption is enabled |
| `LARK_REPLY_IN_THREAD` | `false` | Set `true` to create topic threads for DM replies |
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

Inbound attachments are downloaded through the message-resource API, uploaded via AMP's init/PUT/confirm attachment flow, and referenced in the route payload. The gateway accepts at most 10 attachments of at most 25 MB each; messages over either limit receive a clear reply and are not routed. Outbound AMP references are fetched through their capability URL (inline base64 remains supported), then uploaded through Lark's resource APIs. Inbound filenames keep their name with characters outside `[a-zA-Z0-9._-]` replaced (`Offer (3).pdf` becomes `Offer_3_.pdf`); a name with almost nothing left after that (for example in another script) uses the Lark file key with the original extension; images get an extension from their content type. Structured Markdown (headings, lists, tables, code blocks, links) is sent as a Card JSON 2.0 card, whose markdown element renders headings, tables and code blocks (Card JSON 2.0 needs a recent Lark client; an outdated client shows an upgrade prompt instead of the card); simple text stays plain text. Set `context.lark.format` to `text` or `card` to override. Cards have no header unless the agent sets `context.lark.title`, which is shown on the first card of the reply. Long text is split into chunks below the Lark limits, at paragraph or line breaks where possible. Up to five AMP buttons (`context.lark.buttons: [{label, action, value}]`) become card buttons on the last chunk, carrying the agent, action, value, owner slug, and AMP thread reference; a click reaches the agent as a new request with `context.lark.card_action = {action, value, clicker}`, and the clicker sees a short "Received" toast.

The inbound event is durably queued before acknowledgement. Event and message IDs are deduplicated on disk for 24 hours. Thread context survives restarts and expires after 30 days; the store is capped at 5,000 entries and 2 MB. Inbound failures use persisted exponential backoff and are parked after eight attempts or 24 hours with one sender notification. Outbound delivery retries with exponential backoff and parks aged, repeatedly failing messages in the sibling `undeliverable/` directory.

## Docker

Copy `routing.example.yaml` to `config/routing.yaml`, configure `.env`, and set `LARK_GATEWAY_UID` and `LARK_GATEWAY_GID` to the host UID/GID that owns the AMP files (for example, `id -u` and `id -g`). Then run `docker compose up -d lark-gateway`. Compose publishes `127.0.0.1:3025`, mounts the host `~/.agent-messaging` directory so outbound polling works, and mounts the whole routing directory read-only so hot reload continues to work. The container runs as the configured numeric gateway user; ensure the mounted inbox files and directories are owned by or writable to that UID/GID. The image binds inside its container to `0.0.0.0`; keep the host port mapping loopback-only unless intentionally exposing the management API with `ADMIN_TOKEN` set.

## Live smoke procedure

This procedure needs a published Lark app, real app credentials, a running AI Maestro instance, and one test person in `routing.yaml`.

1. Start the gateway and check `curl -fsS http://127.0.0.1:3025/health`; verify `configured: true` and that the long-connection log says ready.
2. DM the bot from the configured person and send `smoke text`. Verify one AMP route reaches that person's configured agent and the agent reply appears as a reply in the same DM.
3. Send a small PDF or image. Verify the agent receives one AMP attachment with the expected (sanitized) filename and content type, then ask the agent to return a small image/file and verify Lark receives it.
4. Ask the agent to send a structured Markdown response with a button, for example an `Approve` button whose value is `{"approved":true}`. Click it as the card owner and verify an AMP request arrives with `context.lark.card_action`; verify the agent's next reply lands in the same DM. Repeat with a different configured person and verify Lark returns the owner-only refusal toast and no AMP request.
5. Send a DM from an unknown account and a message in a group without mentioning the bot. Verify the configured unknown response and silence respectively; mention the bot in a group and verify only the pointer line is sent.

Record the Lark app release, gateway version, the checks above, and any scope errors before treating the live integration as accepted. Fake fixtures cover normal CI; live Lark tests cannot run without an app.
