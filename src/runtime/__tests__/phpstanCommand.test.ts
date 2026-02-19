import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildPhpstanAnalyzeCommand,
  findNearestComposerJson,
  resolvePhpstanRuntime,
} from '../phpstanCommand.js';

const tmpDirs: string[] = [];

async function createProjectDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'phpstan-ls-lite-runtime-cmd-test-'));
  tmpDirs.push(dir);
  return dir;
}

async function createFile(filePath: string, content = ''): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (!dir) {
      continue;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

describe('findNearestComposerJson', () => {
  it('finds composer.json from nested file path', async () => {
    const project = await createProjectDir();
    const composerJsonPath = path.join(project, 'composer.json');
    await createFile(composerJsonPath, '{}');
    const nestedFile = path.join(project, 'src', 'Foo.php');
    await createFile(nestedFile, '<?php');

    const found = await findNearestComposerJson(nestedFile);
    assert.equal(found, composerJsonPath);
  });

  it('returns null when no composer.json exists', async () => {
    const project = await createProjectDir();
    const nestedFile = path.join(project, 'src', 'Foo.php');
    await createFile(nestedFile, '<?php');

    const found = await findNearestComposerJson(nestedFile);
    assert.equal(found, null);
  });
});

describe('resolvePhpstanRuntime', () => {
  it('returns detected runtime and project cwd', async () => {
    const project = await createProjectDir();
    await createFile(path.join(project, 'vendor', 'bin', 'phpstan'), '#!/usr/bin/env php\n');
    await createFile(path.join(project, 'composer.json'), '{}');
    const filePath = path.join(project, 'src', 'Foo.php');
    await createFile(filePath, '<?php');

    const resolved = await resolvePhpstanRuntime(filePath);
    assert.equal(resolved.kind, 'detected');
    assert.equal(resolved.workingDirectory, project);
    assert.equal(resolved.composerJsonPath, path.join(project, 'composer.json'));
  });

  it('returns fallback runtime when composer.json is missing', async () => {
    const project = await createProjectDir();
    const filePath = path.join(project, 'src', 'Foo.php');
    await createFile(filePath, '<?php');

    const resolved = await resolvePhpstanRuntime(filePath);
    assert.deepEqual(resolved, {
      kind: 'fallback',
      runtime: {
        kind: 'command',
        command: 'phpstan',
        args: [],
        source: 'fallback',
      },
      composerJsonPath: null,
      workingDirectory: path.join(project, 'src'),
    });
  });
});

describe('buildPhpstanAnalyzeCommand', () => {
  it('builds command from detected command runtime', () => {
    const command = buildPhpstanAnalyzeCommand({
      resolvedRuntime: {
        kind: 'detected',
        runtime: {
          kind: 'command',
          command: 'phpstan',
          args: ['--memory-limit=2G'],
          source: 'scripts.phpstan',
        },
        composerJsonPath: '/repo/composer.json',
        workingDirectory: '/repo',
      },
      targets: ['/repo/src/Foo.php'],
    });

    assert.deepEqual(command, {
      command: 'phpstan',
      args: [
        '--memory-limit=2G',
        'analyze',
        '--error-format=json',
        '--no-progress',
        '--no-interaction',
        '--',
        '/repo/src/Foo.php',
      ],
      cwd: '/repo',
    });
  });

  it('normalizes scripts that already include analyze subcommand', () => {
    const command = buildPhpstanAnalyzeCommand({
      resolvedRuntime: {
        kind: 'detected',
        runtime: {
          kind: 'command',
          command: 'phpstan',
          args: ['analyze', '--memory-limit=1G'],
          source: 'scripts.phpstan',
        },
        composerJsonPath: '/repo/composer.json',
        workingDirectory: '/repo',
      },
      targets: ['/repo/src/Foo.php'],
      options: ['--xdebug'],
    });

    assert.deepEqual(command.args, [
      '--memory-limit=1G',
      'analyze',
      '--error-format=json',
      '--no-progress',
      '--no-interaction',
      '--xdebug',
      '--',
      '/repo/src/Foo.php',
    ]);
  });

  it('builds command from detected file runtime with config', () => {
    const command = buildPhpstanAnalyzeCommand({
      resolvedRuntime: {
        kind: 'detected',
        runtime: {
          kind: 'file',
          executablePath: '/repo/vendor/bin/phpstan',
          args: [],
          source: 'default-vendor-dir',
        },
        composerJsonPath: '/repo/composer.json',
        workingDirectory: '/repo',
      },
      targets: ['/repo/src/Foo.php', '/repo/src/Bar.php'],
      configPath: '/repo/phpstan.neon',
      errorFormat: 'raw',
    });

    assert.deepEqual(command, {
      command: '/repo/vendor/bin/phpstan',
      args: [
        'analyze',
        '--error-format=raw',
        '--no-progress',
        '--no-interaction',
        '-c',
        '/repo/phpstan.neon',
        '--',
        '/repo/src/Foo.php',
        '/repo/src/Bar.php',
      ],
      cwd: '/repo',
    });
  });
});

