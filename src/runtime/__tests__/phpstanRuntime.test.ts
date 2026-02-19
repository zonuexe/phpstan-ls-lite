import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectPhpstanRuntimeFromComposerJsonPath } from '../phpstanRuntime.js';

const tmpDirs: string[] = [];

async function createProjectDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'phpstan-ls-lite-test-'));
  tmpDirs.push(dir);
  return dir;
}

async function createFile(filePath: string, content = '#!/usr/bin/env php\n'): Promise<void> {
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

describe('detectPhpstanRuntimeFromComposerJsonPath', () => {
  it('detects phpstan command from scripts.phpstan string with arguments', async () => {
    const project = await createProjectDir();
    const composerJsonPath = path.join(project, 'composer.json');
    await writeFile(
      composerJsonPath,
      JSON.stringify({
        scripts: {
          phpstan: 'phpstan --memory-limit=2G --error-format=json',
        },
      }),
      'utf8',
    );

    const detected = await detectPhpstanRuntimeFromComposerJsonPath(composerJsonPath);
    assert.deepEqual(detected, {
      kind: 'command',
      command: 'phpstan',
      args: ['--memory-limit=2G', '--error-format=json'],
      source: 'scripts.phpstan',
    });
  });

  it('detects phpstan path from scripts.phpstan array', async () => {
    const project = await createProjectDir();
    const composerJsonPath = path.join(project, 'composer.json');
    await createFile(path.join(project, 'tools', 'phpstan'));
    await writeFile(
      composerJsonPath,
      JSON.stringify({
        scripts: {
          phpstan: ['echo setup', './tools/phpstan --memory-limit=1G'],
        },
      }),
      'utf8',
    );

    const detected = await detectPhpstanRuntimeFromComposerJsonPath(composerJsonPath);
    assert.deepEqual(detected, {
      kind: 'file',
      executablePath: path.join(project, 'tools', 'phpstan'),
      args: ['--memory-limit=1G'],
      source: 'scripts.phpstan',
    });
  });

  it('falls back to config.vendor-dir/bin/phpstan when scripts.phpstan has no phpstan token', async () => {
    const project = await createProjectDir();
    const composerJsonPath = path.join(project, 'composer.json');
    const vendorDir = path.join(project, 'custom-vendor');
    await createFile(path.join(vendorDir, 'bin', 'phpstan'));
    await writeFile(
      composerJsonPath,
      JSON.stringify({
        scripts: {
          phpstan: 'echo skip',
        },
        config: {
          'vendor-dir': 'custom-vendor',
        },
      }),
      'utf8',
    );

    const detected = await detectPhpstanRuntimeFromComposerJsonPath(composerJsonPath);
    assert.deepEqual(detected, {
      kind: 'file',
      executablePath: path.join(vendorDir, 'bin', 'phpstan'),
      args: [],
      source: 'config.vendor-dir',
    });
  });

  it('uses config.vendor-dir before default vendor/bin/phpstan', async () => {
    const project = await createProjectDir();
    const composerJsonPath = path.join(project, 'composer.json');
    await createFile(path.join(project, 'custom-vendor', 'bin', 'phpstan'));
    await createFile(path.join(project, 'vendor', 'bin', 'phpstan'));
    await writeFile(
      composerJsonPath,
      JSON.stringify({
        config: {
          'vendor-dir': 'custom-vendor',
        },
      }),
      'utf8',
    );

    const detected = await detectPhpstanRuntimeFromComposerJsonPath(composerJsonPath);
    assert.deepEqual(detected, {
      kind: 'file',
      executablePath: path.join(project, 'custom-vendor', 'bin', 'phpstan'),
      args: [],
      source: 'config.vendor-dir',
    });
  });

  it('uses default vendor/bin/phpstan when vendor-dir is not configured', async () => {
    const project = await createProjectDir();
    const composerJsonPath = path.join(project, 'composer.json');
    await createFile(path.join(project, 'vendor', 'bin', 'phpstan'));
    await writeFile(composerJsonPath, JSON.stringify({}), 'utf8');

    const detected = await detectPhpstanRuntimeFromComposerJsonPath(composerJsonPath);
    assert.deepEqual(detected, {
      kind: 'file',
      executablePath: path.join(project, 'vendor', 'bin', 'phpstan'),
      args: [],
      source: 'default-vendor-dir',
    });
  });

  it('detects bamarni plugin phpstan runtime from default vendor-bin', async () => {
    const project = await createProjectDir();
    const composerJsonPath = path.join(project, 'composer.json');
    await createFile(path.join(project, 'vendor-bin', 'phpstan', 'vendor', 'bin', 'phpstan'));
    await writeFile(
      composerJsonPath,
      JSON.stringify({
        config: {
          'allow-plugins': {
            'bamarni/composer-bin-plugin': true,
          },
        },
      }),
      'utf8',
    );

    const detected = await detectPhpstanRuntimeFromComposerJsonPath(composerJsonPath);
    assert.deepEqual(detected, {
      kind: 'file',
      executablePath: path.join(project, 'vendor-bin', 'phpstan', 'vendor', 'bin', 'phpstan'),
      args: [],
      source: 'bamarni-composer-bin-plugin',
    });
  });

  it('detects bamarni plugin phpstan runtime from custom target-directory', async () => {
    const project = await createProjectDir();
    const composerJsonPath = path.join(project, 'composer.json');
    await createFile(path.join(project, 'tools-bin', 'phpstan', 'vendor', 'bin', 'phpstan'));
    await writeFile(
      composerJsonPath,
      JSON.stringify({
        config: {
          'allow-plugins': {
            'bamarni/composer-bin-plugin': true,
          },
        },
        extra: {
          'bamarni-bin': {
            'target-directory': 'tools-bin',
          },
        },
      }),
      'utf8',
    );

    const detected = await detectPhpstanRuntimeFromComposerJsonPath(composerJsonPath);
    assert.deepEqual(detected, {
      kind: 'file',
      executablePath: path.join(project, 'tools-bin', 'phpstan', 'vendor', 'bin', 'phpstan'),
      args: [],
      source: 'bamarni-composer-bin-plugin',
    });
  });

  it('respects priority: scripts.phpstan wins over other strategies', async () => {
    const project = await createProjectDir();
    const composerJsonPath = path.join(project, 'composer.json');
    await createFile(path.join(project, 'custom-vendor', 'bin', 'phpstan'));
    await createFile(path.join(project, 'vendor', 'bin', 'phpstan'));
    await createFile(path.join(project, 'vendor-bin', 'phpstan', 'vendor', 'bin', 'phpstan'));
    await writeFile(
      composerJsonPath,
      JSON.stringify({
        scripts: {
          phpstan: 'phpstan --memory-limit=2G',
        },
        config: {
          'vendor-dir': 'custom-vendor',
          'allow-plugins': {
            'bamarni/composer-bin-plugin': true,
          },
        },
      }),
      'utf8',
    );

    const detected = await detectPhpstanRuntimeFromComposerJsonPath(composerJsonPath);
    assert.deepEqual(detected, {
      kind: 'command',
      command: 'phpstan',
      args: ['--memory-limit=2G'],
      source: 'scripts.phpstan',
    });
  });

  it('returns null for invalid composer.json', async () => {
    const project = await createProjectDir();
    const composerJsonPath = path.join(project, 'composer.json');
    await writeFile(composerJsonPath, '{invalid json', 'utf8');

    const detected = await detectPhpstanRuntimeFromComposerJsonPath(composerJsonPath);
    assert.equal(detected, null);
  });
});

