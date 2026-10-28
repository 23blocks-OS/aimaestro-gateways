import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  resolveBindAddress,
  isLoopbackAddress,
  formatHttpUrl,
  exposureWarning,
} from '../bind-address.js';

describe('resolveBindAddress', () => {
  it('defaults to loopback', () => {
    assert.strictEqual(resolveBindAddress({}), '127.0.0.1');
    assert.strictEqual(resolveBindAddress({ BIND_ADDRESS: '  ', HOST: '' }), '127.0.0.1');
  });
  it('reads HOST', () => {
    assert.strictEqual(resolveBindAddress({ HOST: '0.0.0.0' }), '0.0.0.0');
  });
  it('BIND_ADDRESS wins over HOST', () => {
    assert.strictEqual(resolveBindAddress({ BIND_ADDRESS: '10.0.0.5', HOST: '0.0.0.0' }), '10.0.0.5');
  });
});

describe('isLoopbackAddress', () => {
  it('accepts loopback forms', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) {
      assert.strictEqual(isLoopbackAddress(a), true, a);
    }
  });
  it('rejects everything else', () => {
    for (const a of ['0.0.0.0', '::', '192.168.1.5', '1127.0.0.1', '127.0.0.1.evil.com']) {
      assert.strictEqual(isLoopbackAddress(a), false, a);
    }
  });
});

describe('formatHttpUrl', () => {
  it('brackets IPv6', () => {
    assert.strictEqual(formatHttpUrl('127.0.0.1', 3022), 'http://127.0.0.1:3022');
    assert.strictEqual(formatHttpUrl('::1', 3022), 'http://[::1]:3022');
  });
});

describe('exposureWarning', () => {
  it('warns on non-loopback without a token', () => {
    const w = exposureWarning('0.0.0.0', '');
    assert.ok(w && w.includes('SECURITY WARNING') && w.includes('ADMIN_TOKEN'));
  });
  it('is quiet on loopback, or when a token is set', () => {
    assert.strictEqual(exposureWarning('127.0.0.1', ''), null);
    assert.strictEqual(exposureWarning('0.0.0.0', 'secret'), null);
    assert.ok(!(exposureWarning('0.0.0.0', undefined) ?? '').includes('secret'));
  });
});
