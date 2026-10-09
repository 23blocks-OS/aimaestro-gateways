import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { errLine, clip, createLogOnce } from '../log-hygiene.js';

describe('errLine', () => {
  it('combines message, data.error and code on one line without a stack', () => {
    const err = Object.assign(new Error('An API error occurred: channel_not_found'), {
      data: { error: 'channel_not_found', response_metadata: { big: 'x'.repeat(5000) } },
      code: 'slack_webapi_platform_error',
    });
    const line = errLine(err);
    assert.match(line, /channel_not_found/);
    assert.match(line, /code=slack_webapi_platform_error/);
    assert.ok(!line.includes('\n'));
    assert.ok(!line.includes(' at '));
    assert.ok(!line.includes('xxxx'));
  });

  it('truncates to 300 characters', () => {
    const line = errLine(new Error('y'.repeat(2000)));
    assert.strictEqual(line.length, 300);
    assert.ok(line.endsWith('...'));
  });

  it('handles strings, null and odd objects', () => {
    assert.strictEqual(errLine('boom\nline2'), 'boom line2');
    assert.strictEqual(errLine(null), 'null');
    assert.strictEqual(errLine({}), '[object Object]');
  });
});

describe('clip', () => {
  it('flattens whitespace and truncates', () => {
    assert.strictEqual(clip('a\n b', 80), 'a b');
    assert.strictEqual(clip('z'.repeat(200), 80).length, 80);
  });
});

describe('createLogOnce', () => {
  it('logs first, counts repeats, emits one summary when the window closes', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const lines: string[] = [];
    const logOnce = createLogOnce({ windowMs: 5 * 60 * 1000, sink: (l) => lines.push(l) });

    logOnce('k', 'pong not received');
    logOnce('k', 'pong not received');
    logOnce('k', 'pong not received');
    logOnce('other', 'different');
    assert.deepStrictEqual(lines, ['pong not received', 'different']);

    t.mock.timers.tick(5 * 60 * 1000);
    assert.strictEqual(lines.length, 3);
    assert.match(lines[2], /pong not received \(repeated 2 times/);

    // Window closed: next occurrence logs again.
    logOnce('k', 'pong not received');
    assert.strictEqual(lines.length, 4);
    mock.timers.reset();
  });

  it('emits no summary when nothing repeated', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const lines: string[] = [];
    const logOnce = createLogOnce({ windowMs: 1000, sink: (l) => lines.push(l) });
    logOnce('a', 'once');
    t.mock.timers.tick(1000);
    assert.deepStrictEqual(lines, ['once']);
  });
});
