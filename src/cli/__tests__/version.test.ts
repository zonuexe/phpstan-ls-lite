import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatVersionText, getServerVersion } from '../version.js';

describe('getServerVersion', () => {
  it('loads version from package.json', async () => {
    const version = await getServerVersion();
    assert.match(version, /^\d+\.\d+\.\d+/);
  });
});

describe('formatVersionText', () => {
  it('formats CLI version string', () => {
    assert.equal(formatVersionText('0.0.3'), 'phpstan-ls-lite 0.0.3');
  });
});
