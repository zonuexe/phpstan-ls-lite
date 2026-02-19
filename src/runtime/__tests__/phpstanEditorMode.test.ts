import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEditorModeArgs,
  applyTempFileFallbackArgs,
  getPhpstanVersionCommand,
  isPhpstanEditorModeSupported,
} from '../phpstanEditorMode.js';

describe('isPhpstanEditorModeSupported', () => {
  it('supports PHPStan 1.12.27 and newer in v1', () => {
    assert.equal(isPhpstanEditorModeSupported('PHPStan - PHP Static Analysis Tool 1.12.27'), true);
    assert.equal(isPhpstanEditorModeSupported('PHPStan - PHP Static Analysis Tool 1.12.26'), false);
  });

  it('supports PHPStan 2.1.17 and newer in v2', () => {
    assert.equal(isPhpstanEditorModeSupported('PHPStan - PHP Static Analysis Tool 2.1.17'), true);
    assert.equal(isPhpstanEditorModeSupported('PHPStan - PHP Static Analysis Tool 2.1.16'), false);
  });

  it('supports dev snapshots and higher majors', () => {
    assert.equal(isPhpstanEditorModeSupported('PHPStan - PHP Static Analysis Tool 2.1.x-dev@abc123'), true);
    assert.equal(isPhpstanEditorModeSupported('PHPStan - PHP Static Analysis Tool 3.0.0'), true);
  });
});

describe('editor mode args', () => {
  it('injects --tmp-file and --instead-of before target separator', () => {
    const base = {
      command: 'phpstan',
      cwd: '/repo',
      args: ['analyze', '--error-format=json', '--', '/repo/src/Foo.php'],
    };
    const applied = applyEditorModeArgs(base, '/tmp/phpstan-ls.php', '/repo/src/Foo.php');
    assert.deepEqual(applied.args, [
      'analyze',
      '--error-format=json',
      '--tmp-file',
      '/tmp/phpstan-ls.php',
      '--instead-of',
      '/repo/src/Foo.php',
      '--',
      '/repo/src/Foo.php',
    ]);
  });

  it('replaces target with tmp file when editor mode is unavailable', () => {
    const base = {
      command: 'phpstan',
      cwd: '/repo',
      args: ['analyze', '--error-format=json', '--', '/repo/src/Foo.php'],
    };
    const applied = applyTempFileFallbackArgs(base, '/tmp/phpstan-ls.php');
    assert.deepEqual(applied.args, [
      'analyze',
      '--error-format=json',
      '--',
      '/tmp/phpstan-ls.php',
    ]);
  });
});

describe('getPhpstanVersionCommand', () => {
  it('builds version command from detected file runtime', () => {
    const versionCommand = getPhpstanVersionCommand({
      kind: 'detected',
      runtime: {
        kind: 'file',
        executablePath: '/repo/vendor/bin/phpstan',
        args: [],
        source: 'default-vendor-dir',
      },
      composerJsonPath: '/repo/composer.json',
      workingDirectory: '/repo',
    });
    assert.deepEqual(versionCommand, {
      command: '/repo/vendor/bin/phpstan',
      args: ['--version'],
      cwd: '/repo',
    });
  });
});

