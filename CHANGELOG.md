# Changelog

Per-gateway versions live in each `<gateway>/package.json`. Entries list the
gateway versions they changed.

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
