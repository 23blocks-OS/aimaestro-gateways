import { describe, it } from 'node:test';
import assert from 'node:assert';
import { LogLevel } from '@slack/bolt';
import { createBoltLogger } from '../bolt-logger.js';

describe('createBoltLogger', () => {
  it('rate-limits repeated warnings and collapses numbered client names', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const out: string[] = [];
    const log = createBoltLogger(LogLevel.INFO, (_l, line) => out.push(line), 60_000);
    log.setName('socket-mode:SocketModeClient:0');
    log.warn("A pong wasn't received from the server before the timeout of 5000ms!");
    log.setName('socket-mode:SocketModeClient:1');
    log.warn("A pong wasn't received from the server before the timeout of 5000ms!");
    log.warn("A pong wasn't received from the server before the timeout of 5000ms!");
    assert.strictEqual(out.length, 1);
    t.mock.timers.tick(60_000);
    assert.strictEqual(out.length, 2);
    assert.match(out[1], /repeated 2 times/);
  });

  it('passes info through and honours the level', () => {
    const out: string[] = [];
    const log = createBoltLogger(LogLevel.WARN, (_l, line) => out.push(line));
    log.info('hidden');
    log.setLevel(LogLevel.INFO);
    log.info('shown');
    assert.strictEqual(out.length, 1);
    assert.match(out[0], /shown/);
  });

  it('reduces error objects to one line', () => {
    const out: string[] = [];
    const log = createBoltLogger(LogLevel.INFO, (_l, line) => out.push(line));
    log.error(Object.assign(new Error('getaddrinfo EAI_AGAIN slack.com'), { code: 'EAI_AGAIN' }));
    assert.strictEqual(out.length, 1);
    assert.ok(!out[0].includes('\n'));
    assert.match(out[0], /EAI_AGAIN/);
  });
});
