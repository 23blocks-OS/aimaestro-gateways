# Changelog

Per-gateway versions live in each `<gateway>/package.json`. Entries list the
gateway versions they changed.

## 2026-10-28 (4)

### Fix: a reply could fail with "No such file or directory" in the gateway inbox

Gateway versions: slack-gateway 0.1.5, email-gateway 0.1.5, discord-gateway 0.1.4, whatsapp-gateway 0.1.4, google-chat-gateway 0.1.5.

The outbound poller removed a sender folder in the gateway inbox as soon as it was empty. `amp-send.sh` creates that folder and writes the message a moment later (after its content checks), so a poll landing in that gap deleted the folder and the agent reply failed with "No such file or directory". An empty folder is now removed only after it has been unchanged for 60 seconds. Found on a real run: a Claude Code agent could not deliver a reply to the Google Chat gateway. No automated test covers the timing; the type checks and the existing tests pass.

## 2026-10-28 (3)

### Fix: gateways discover the AMP tenant from AI Maestro

Gateway versions: slack-gateway 0.1.4, email-gateway 0.1.4, discord-gateway 0.1.3, whatsapp-gateway 0.1.3, google-chat-gateway 0.1.4.

On a fresh AI Maestro install the auto-registration used tenant `default` and AI Maestro refused it (`invalid_field`, "configured for organization ...").
AI Maestro only registers agents under its organization, and the organization is the tenant. Now, in every gateway's `amp-bootstrap`:

- `AMP_TENANT` is optional. When unset, the tenant is the organization from `GET /api/organization` (older servers: the provider domain from `/api/v1/info` or `/.well-known/agent-messaging.json`). `AMP_TENANT` still overrides.
- If registration fails with `invalid_field` and `details.expected_tenant`, it retries once with that tenant and logs it.
- If AI Maestro answers `organization_not_set` (or reports no organization), it prints how to set one (dashboard, or `POST /api/organization {"organization":"<name>"}`) and waits with backoff capped at 60s, logging at most once a minute, then continues by itself once the organization is set. It does not exit, so a process manager does not crash-loop.
- The saved registration file is named after the domain AI Maestro returns in the address, not a hard-coded `default.aimaestro.local`.
- The shared logic is in `src/amp-tenant.ts` (identical in all five packages). New tests with a fake fetch cover discovery, the retry and the wait loop in slack, discord, email and google-chat. whatsapp-gateway has no test setup; its copy of `amp-tenant.ts` is byte-identical and is covered by those tests.

### Fix: Google Chat shared-app prefix is Markdown bold

Gateway versions: google-chat-gateway 0.1.4.

Replies from a shared app were prefixed `*[agent]*`. Chat apps now default to standard Markdown, where a single asterisk is italic, so the prefix is now `**[agent]**`. Dedicated apps are unchanged (no prefix).

## 2026-10-28 (keyless Chat tokens)

### Feature: Google Chat gateway can run without a key file on a cloud VM

Gateway versions: google-chat-gateway 0.1.3.

On a Google Cloud VM the machine's token carries only the broad cloud-platform scope, which the Chat API refuses ("insufficient authentication scopes"). Set `GCHAT_IMPERSONATE_SA` (or `impersonateServiceAccount` in `bots.json`) to a service account email and the gateway asks Google for short-lived `chat.bot` tokens for that account with the machine's own login, so no key file has to be created or stored. The machine's account needs `roles/iam.serviceAccountTokenCreator` on that service account, and the IAM Credentials API must be enabled. Key files and ADC keep working as before. One new test (28 total).

## 2026-10-28 (2)

### Fix: Docker port mapping, configurable bind address

Gateway versions: slack-gateway 0.1.3, email-gateway 0.1.3, discord-gateway 0.1.2, whatsapp-gateway 0.1.2,
google-chat-gateway 0.1.2.

Every gateway bound its HTTP server to `127.0.0.1`, which inside a container is the container's own loopback, so the
published port never connected. Now:

- The bind address comes from `BIND_ADDRESS` (or `HOST`), default `127.0.0.1`, so runs outside a container are unchanged.
- Each Dockerfile sets `BIND_ADDRESS=0.0.0.0` (container only). `docker-compose.yml` already publishes `127.0.0.1:PORT:PORT`,
  so the host side stays loopback-only. No Dockerfile or compose health check existed, so none changed.
- A non-loopback bind with `ADMIN_TOKEN` unset logs a loud `[SECURITY WARNING]` at startup (the process still starts).
- slack-gateway: `POST /api/slack/send` now returns 403 when `ADMIN_TOKEN` is unset, like the PATCH config routes, so an
  unauthenticated API cannot post to Slack. Set `ADMIN_TOKEN` to keep using it.
- New `src/bind-address.ts` in each gateway, with tests in discord, slack, email and google-chat (whatsapp has no test setup).

## 2026-10-28

### Security: dependency and Node updates, 2026-10-28

Gateway versions: slack-gateway 0.1.2, email-gateway 0.1.2, discord-gateway 0.1.1, whatsapp-gateway 0.1.1,
google-chat-gateway 0.1.1. Message routing and behaviour are unchanged. `npm audit` is at 0 in every package
(it was 2 high at the repo root, 9 in slack, 11 in discord, 6 in email, 13 in the email UI, 17 in whatsapp, 6 in google-chat).

**Node.** CI, Docker base images and `engines` move to Node 24 (`engines`: `^22.23.4 || >=24.22.1`), the lines that carry the
October 21 2026 Node.js security release. Node 20 is end of life. `@types/node` is now ^24.

**GitHub Actions.** `actions/checkout` and `actions/setup-node` move to v7; the workflow `permissions` are `contents: read`.

**Code.** email-gateway: the attachment folder and file names built from the sender's `Message-Id` header and attachment
names could be `..`. They now go through `safeSegment`, so they stay one plain path segment (new tests).

**Dependencies fixed, by package (advisory ids from `npm audit`):**

- critical: proxy-addr (GHSA-jqcg-44mw-7w3h, via express; slack, discord, email, whatsapp); protobufjs (12 advisories
  including GHSA-xq3m-2v4x-88gg arbitrary code execution; whatsapp, forced to ^7.6.6 for the libsignal copy with an
  `overrides` entry); @whiskeysockets/baileys (GHSA-qvv5-jq5g-4cgg, whatsapp, now 6.7.24).
- high: axios (about 37 advisories, SSRF/proxy bypass, prototype pollution, header injection; slack, whatsapp);
  body-parser (GHSA-v422-hmwv-36x6, GHSA-27r3-jxmh-p828); path-to-regexp (GHSA-37ch-88jc-xwx2, GHSA-j3q9-mxjg-w52f,
  GHSA-27v5-c462-wpq7); ws (GHSA-58qx-3vcg-4xpx, GHSA-96hv-2xvq-fx4p); undici (20 advisories, discord via discord.js);
  lodash (GHSA-r5fr-rjxr-66jc, GHSA-f23m-r3pf-42rh, discord); form-data (GHSA-hmw2-7cc7-3qxx); music-metadata (6) and
  sharp (3) in whatsapp; brace-expansion and js-yaml at the root (dev tooling).
- email UI (dev build tools): vite (9 advisories), postcss (4), rollup (GHSA-mw96-cpmx-2vgc), picomatch,
  browserslist, nanoid, source-map-js; react-router-dom moves 6 to 7 (GHSA-wrjc-x8rr-h8h6, GHSA-337j-9hxr-rhxg,
  GHSA-2j2x-hqr9-3h42, GHSA-jjmj-jmhj-qwj2), the UI builds unchanged.
- moderate: express and qs (4 advisories, e.g. GHSA-w7fw-mjwx-w883), follow-redirects (GHSA-r4q5-vmmm-2653),
  yaml (GHSA-48c2-rrv3-qjmp), file-type (2), discord.js and @discordjs/rest; uuid (GHSA-w5hq-g745-h8pq) in
  google-chat, fixed by @google-cloud/pubsub 4 to 6.
- low: esbuild (GHSA-g7r4-m6w7-qqqr, dev server), @babel/core (GHSA-4x5r-pxfx-6jf8).

## Unreleased

### google-chat-gateway 0.1.0 (new)

Connects Google Chat to AI Maestro agents. Events come in through a Cloud Pub/Sub pull
subscription (no public URL), answers go out through the Chat REST API.

- **Two identity modes in one process.** A shared Chat app routes by `@AIM:agent` tag, thread affinity, then a default
  agent. A dedicated Chat app per agent (one Cloud project each, because Google allows one app per project and the app
  is the identity people see) always goes to its agent. `bots.json` mixes both.
- Reads both event formats (Workspace add-on and classic), de-duplicates redeliveries, ignores other apps' messages.
- Prompt-injection screening and the operator allowlist (`OPERATOR_GCHAT_USERS`) as in the other gateways.
- Agents can start a conversation with a space, a user or an email through `context.gchat.to`.
- Long answers are split under Google's 32,000-byte limit and posted in the same thread.
- Same retry policy and undeliverable folder as the Slack gateway, with Google status codes.
- Tested with fake events only (19 tests). Not yet run against a live Workspace; see the README for the items to verify.

## 0.1.1 - 2026-10-09

### slack-gateway 0.1.1, email-gateway 0.1.1

Log volume and retry fixes. A permanent Slack error used to retry every 3 s and
log the whole error object each time, which filled a disk (13 GB pm2 log).
Message routing and what gets delivered are unchanged.

- Slack outbound: failed posts now back off per file (3 s, 6 s, 12 s ... capped
  at 5 min). Errors about that one message (`channel_not_found`, `not_in_channel`,
  `invalid_blocks`, `is_archived`, `message_too_long` and a few siblings) park the
  file in `undeliverable/` at once. An unrecognised Slack error about the message
  parks it after 20 failed attempts or 24 h. Workspace-level failures (`invalid_auth`,
  `token_revoked`, `token_expired`, `account_inactive`, rate limits) and network
  failures never park anything: they back off to the 5 minute cap and keep retrying,
  so a revoked token or an outage cannot push the whole queue out of retry. One log
  line per transition instead of one per attempt.
- Slack: Bolt now uses a rate-limited logger, so repeated socket-mode warnings
  ("pong wasn't received", `getaddrinfo EAI_AGAIN`) log once per 5 minutes with
  a "repeated N times" summary.
- Email outbound: unparseable files move to `undeliverable/` instead of being
  logged every 30 s forever; incomplete reply payloads log keys only.
- Email server: HTTP log is method, path and status only, `/health` is skipped;
  per-email logging cut from 6-9 lines to 2-3; error objects reduced to
  `err.message`; flagged injection text truncated to 80 characters.
- Both: error objects in log lines are reduced to one line of at most 300
  characters (`errLine`); new shared helpers `log-hygiene.ts` (identical copy in
  each gateway) and `retry-policy.ts` (Slack).
- Tests: added `npm test` to slack-gateway and email-gateway; the root
  `npm test` and `npm run typecheck` now cover all three.
