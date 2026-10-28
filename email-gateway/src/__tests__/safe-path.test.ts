import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { safeSegment } from '../safe-path.js';

describe('safeSegment', () => {
  it('keeps ordinary ids and names unchanged', () => {
    assert.strictEqual(safeSegment('abc123@mail.example.com'), 'abc123@mail.example.com');
    assert.strictEqual(safeSegment('report-v2.pdf'), 'report-v2.pdf');
  });
  it('never yields "." or ".."', () => {
    for (const bad of ['.', '..', '...', '']) {
      const s = safeSegment(bad);
      assert.notStrictEqual(s, '.');
      assert.notStrictEqual(s, '..');
      assert.ok(s.length > 0);
    }
  });
  it('replaces separators', () => {
    const joined = path.join('/base/dir', safeSegment('../../etc/passwd'));
    assert.ok(joined.startsWith('/base/dir/'));
    assert.ok(!safeSegment('a/b\\c').includes('/'));
  });
});
