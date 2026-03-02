import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ResolvedPhpstanRuntime } from '../../runtime/phpstanCommand.js';
import { collectEnvironmentInfo, formatEnvironmentInfo } from '../info.js';

function createCommandRunner(
  resolver: (command: string, args: readonly string[], cwd: string) => {
    exitCode: number | null;
    stdout?: string;
    stderr?: string;
    error?: Error | null;
  },
) {
  return async (command: string, args: readonly string[], cwd: string) => {
    const result = resolver(command, args, cwd);
    return {
      exitCode: result.exitCode,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error ?? null,
    };
  };
}

describe('collectEnvironmentInfo', () => {
  it('collects info with detected file runtime', async () => {
    const runtime: ResolvedPhpstanRuntime = {
      kind: 'detected',
      runtime: {
        kind: 'file',
        executablePath: '/repo/vendor/bin/phpstan',
        args: ['--memory-limit=1G'],
        source: 'default-vendor-dir',
      },
      composerJsonPath: '/repo/composer.json',
      workingDirectory: '/repo',
    };

    const info = await collectEnvironmentInfo({
      cwd: '/repo',
      platform: 'darwin',
      getVersion: async () => '0.0.3',
      getServerPath: async () => '/repo/dist/server.js',
      resolveRuntime: async () => runtime,
      runCommand: createCommandRunner((command, args) => {
        if (command === 'php' && args.join(' ') === '-r echo PHP_VERSION;') {
          return { exitCode: 0, stdout: '8.3.4' };
        }
        if (command === 'php' && args.join(' ') === '-r echo PHP_BINARY;') {
          return { exitCode: 0, stdout: '/usr/bin/php' };
        }
        if (command === '/repo/vendor/bin/phpstan' && args.join(' ') === '--version') {
          return { exitCode: 0, stdout: 'PHPStan - PHP Static Analysis Tool 2.1.18' };
        }
        return { exitCode: 1, stderr: 'unexpected command' };
      }),
    });

    assert.equal(info.serverVersion, '0.0.3');
    assert.equal(info.serverPath, '/repo/dist/server.js');
    assert.equal(info.phpVersion, '8.3.4');
    assert.equal(info.phpBinaryPath, '/usr/bin/php');
    assert.equal(info.phpstanRuntimePath, '/repo/vendor/bin/phpstan');
    assert.equal(info.phpstanVersion, 'PHPStan - PHP Static Analysis Tool 2.1.18');
    assert.deepEqual(info.phpstanRuntimeArgs, ['--memory-limit=1G']);
  });

  it('resolves runtime path for command runtime from PATH', async () => {
    const runtime: ResolvedPhpstanRuntime = {
      kind: 'detected',
      runtime: {
        kind: 'command',
        command: 'phpstan',
        args: [],
        source: 'scripts.phpstan',
      },
      composerJsonPath: '/repo/composer.json',
      workingDirectory: '/repo',
    };

    const info = await collectEnvironmentInfo({
      cwd: '/repo',
      platform: 'darwin',
      getVersion: async () => '0.0.3',
      getServerPath: async () => '/repo/dist/server.js',
      resolveRuntime: async () => runtime,
      runCommand: createCommandRunner((command, args) => {
        if (command === 'php' && args.join(' ') === '-r echo PHP_VERSION;') {
          return { exitCode: 0, stdout: '8.4.0' };
        }
        if (command === 'php' && args.join(' ') === '-r echo PHP_BINARY;') {
          return { exitCode: 0, stdout: '/opt/homebrew/bin/php' };
        }
        if (command === 'phpstan' && args.join(' ') === '--version') {
          return { exitCode: 0, stdout: 'PHPStan - PHP Static Analysis Tool 1.12.30' };
        }
        if (command === 'which' && args.join(' ') === 'phpstan') {
          return { exitCode: 0, stdout: '/usr/local/bin/phpstan\n' };
        }
        return { exitCode: 1, stderr: 'unexpected command' };
      }),
    });

    assert.equal(info.phpstanRuntimePath, '/usr/local/bin/phpstan');
    assert.equal(info.phpstanVersion, 'PHPStan - PHP Static Analysis Tool 1.12.30');
  });
});

describe('formatEnvironmentInfo', () => {
  it('renders stable line-based output', () => {
    const text = formatEnvironmentInfo({
      serverVersion: '0.0.3',
      serverPath: '/repo/dist/server.js',
      cwd: '/repo',
      composerJsonPath: '/repo/composer.json',
      phpVersion: '8.3.4',
      phpBinaryPath: '/usr/bin/php',
      phpstanSource: 'default-vendor-dir',
      phpstanWorkingDirectory: '/repo',
      phpstanRuntimeKind: 'file',
      phpstanRuntimePath: '/repo/vendor/bin/phpstan',
      phpstanRuntimeArgs: [],
      phpstanVersion: 'PHPStan - PHP Static Analysis Tool 2.1.18',
    });

    assert.match(text, /^server\.version: 0\.0\.3$/m);
    assert.match(text, /^server\.path: \/repo\/dist\/server\.js$/m);
    assert.match(text, /^cwd: \/repo/m);
    assert.match(text, /^php.version: 8.3.4/m);
    assert.match(text, /^phpstan\.runtime\.path: \/repo\/vendor\/bin\/phpstan/m);
    assert.match(text, /^phpstan\.runtime\.args: \(none\)$/m);
  });
});
