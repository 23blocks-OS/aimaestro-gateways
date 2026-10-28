# Google Chat Gateway

Connects Google Chat to AI Maestro agents. People DM the app or @mention it in a space; the
gateway routes the message to an agent over AMP and posts the agent's answer back in the same
thread. Agents can also start a conversation with a person or a space.

Events arrive through **Cloud Pub/Sub (pull)**, so the gateway needs **no public URL, tunnel or
open port**. It talks to Google over outbound HTTPS only.

> Status: written from Google's documentation and tested with fake events. It has not run
> against a live Google Workspace yet. Items marked **(unverified)** below are the ones to
> check first on the first real run.

## Two ways to give agents an identity

Google allows **one Chat app per Cloud project**, and the app is what people see (name and
avatar). A Chat app cannot post under another name. So:

| Mode | What people see | Cloud setup | Routing |
|---|---|---|---|
| **Shared app** | One app (say "AI Maestro"). Replies read `*[agent]* text` | One project | `@AIM:agent-name` tag, else the agent already answering the thread, else `AMP_DEFAULT_AGENT` |
| **Dedicated app per agent** | Each agent is its own app, with its own name and avatar | One project per agent | The app's agent, always; tags are ignored |

Both can run in one gateway process (`bots.json` below): for example one dedicated app for the
agent a customer talks to, and one shared app for the internal team.

## Set up one app

You need a Google Workspace account (Business or Enterprise) and a Cloud project with billing
enabled.

1. **Enable APIs** in the project: *Google Chat API* and *Cloud Pub/Sub API*.
2. **Pub/Sub:** create a topic (one per app) and a **pull subscription** on it.
3. **Service account:** create one, download a JSON key, and give it the *Pub/Sub Subscriber*
   role on the subscription. The same key lets the gateway post messages (scope `chat.bot`,
   which the app grants itself; no admin approval needed).
4. **Let Chat publish to the topic.** Chat API → Configuration → connection settings → Cloud
   Pub/Sub, enter the topic. Then grant *Pub/Sub Publisher* on the topic to:
   - the service account email shown there, if the app is built as a Workspace add-on (the
     default), or
   - `chat-api-push@system.gserviceaccount.com`, if you clear "Build this Chat app as a
     Google Workspace add-on".
   The gateway reads both event formats.
5. **Configure the app** (Chat API → Configuration): name (up to 25 characters), avatar (HTTPS
   URL of a square PNG or JPEG), description, turn on *Interactive features* and *Join spaces
   and group conversations*, and set *Visibility* (up to five people or Google Groups while
   testing).
6. **Run the gateway** (below), then open Google Chat → *New chat* → find the app → send a
   message.

### Reaching everyone in the company

While testing, visibility is limited to the people and groups you list. For the whole domain
publish the app to your organization in the Workspace Marketplace SDK and have an admin
install it (admins can install a Chat app for users so it shows up in their direct messages).
This is a Google Workspace admin task and depends on the customer's edition and policies
**(unverified for your tenant)**.

## Run

```bash
cd google-chat-gateway
cp .env.example .env     # fill in project, subscription, key file, default agent
npm install
npm start                # or: pm2 start ecosystem.config.cjs
```

On first start the gateway registers itself with AI Maestro (`AMP_MAESTRO_URL`) as the bridge
agent `gchat-bot` and writes `AMP_API_KEY` into `.env`. It must run on the same host as that
agent's AMP inbox, like the Slack gateway.

### Several apps (`bots.json`)

Set `GCHAT_BOTS_FILE=./bots.json` instead of the three single-app variables. See
`bots.example.json`: each entry is `id`, `projectId`, `subscriptionId`, optional
`credentialsFile`, and optional `agent`. With `agent` the app is dedicated to that agent
(name or AMP address); without it the app is shared and uses tags.

## Talking to agents

- **Direct message** the app. In a dedicated app that is the agent. In a shared app add
  `@AIM:agent-name` to pick one; replies in a thread stay with that agent.
- **In a space**, @mention the app (Chat only delivers @mentions and slash commands in spaces,
  and every message in a DM).
- Messages from people on `OPERATOR_GCHAT_USERS` go through as typed. Everyone else's are
  scanned for prompt-injection patterns and wrapped as untrusted data
  (`<external-content source="google-chat" ...>`), as in the other gateways.

## Agents starting a conversation

An agent sends an AMP message to `gchat-bot` with `context.gchat.to`:

```json
{ "gchat": { "to": "ana@company.com" } }
```

`to` is `spaces/AAAA` (a space the app is in), `users/123` or an email (the direct message with
that person; they have to have opened the app once, or an admin installed it for them
**(email lookup unverified)**). `context.gchat.bot` picks the app; without it the gateway uses
the app dedicated to the sending agent, else the only app. A human reply in that thread comes
back to the same agent.

## Limits and differences from Slack

- No "typing" or reaction on receipt: reactions need user authentication, which an app does not
  have. The reply is the acknowledgement.
- A message is at most 32,000 bytes; longer answers are split into several messages in the thread.
- Pub/Sub delivers at least once and Chat may retry; the gateway ignores an event it has seen in
  the last 10 minutes.
- Messages from other apps are ignored, so two apps in one space cannot loop.
- Attachments from users are not forwarded yet.

## Management API (127.0.0.1 only)

`GET /health` (public), then behind `Authorization: Bearer $ADMIN_TOKEN`: `GET /api/config`,
`GET /api/stats`, `GET /api/activity`.

## Layout

`events.ts` (both event formats) · `routing.ts` (which agent) · `inbound.ts` (Pub/Sub → AMP) ·
`outbound.ts` (AMP inbox → Chat, retry, undeliverable folder) · `chat-client.ts` (REST) ·
`target.ts` (spaces, users, emails) · `content-security.ts` · `thread-store.ts` ·
`retry-policy.ts` · `amp-bootstrap.ts`. Tests: `npm test`.
