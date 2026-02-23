import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const workerPath = path.resolve(process.cwd(), 'php/phpstan-reflection-worker.php');
const tmpRoot = path.join(process.cwd(), '.tmp-tests', `phpstan-ls-lite-test-${process.pid}`);

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('phpstan-reflection-worker', () => {
  it('returns call argument hints from PHPStan reflection', () => {
    const phpProbe = spawnSync('php', ['-v'], { encoding: 'utf8' });
    if (phpProbe.status !== 0) {
      return;
    }

    fs.mkdirSync(tmpRoot, { recursive: true });
    const phpFile = path.join(tmpRoot, 'inlay.php');
    const code = `<?php
strlen('a');
`;
    fs.writeFileSync(phpFile, code, 'utf8');

    const request = {
      protocolVersion: 1,
      id: 'test-1',
      method: 'resolveNodeContext',
      params: {
        filePath: phpFile,
        cursorOffset: 0,
        rangeStartOffset: 0,
        rangeEndOffset: Buffer.byteLength(code, 'utf8'),
        text: code,
        capabilities: ['callArguments'],
      },
    };

    const proc = spawnSync('php', [workerPath], {
      input: `${JSON.stringify(request)}\n`,
      encoding: 'utf8',
    });
    assert.equal(proc.status, 0, proc.stderr);
    const line = proc.stdout.trim().split(/\r?\n/).at(-1) ?? '';
    assert.notEqual(line, '');
    const response = JSON.parse(line) as {
      ok: boolean;
      result?: {
        callArguments?: Array<{
          hints: Array<{ parameterName: string; hide: boolean }>;
        }>;
      };
    };
    assert.equal(response.ok, true);
    const hints = response.result?.callArguments?.flatMap((call) =>
      call.hints.filter((hint) => !hint.hide),
    );
    assert.ok((hints?.length ?? 0) > 0);
    assert.ok(hints?.some((hint) => hint.parameterName === 'string'));
  });

  it('returns hints for nested function calls', () => {
    const phpProbe = spawnSync('php', ['-v'], { encoding: 'utf8' });
    if (phpProbe.status !== 0) {
      return;
    }

    fs.mkdirSync(tmpRoot, { recursive: true });
    const phpFile = path.join(tmpRoot, 'nested.php');
    const code = `<?php
printf("count: %d\\n", count($a));
`;
    fs.writeFileSync(phpFile, code, 'utf8');

    const request = {
      protocolVersion: 1,
      id: 'test-2',
      method: 'resolveNodeContext',
      params: {
        filePath: phpFile,
        cursorOffset: 0,
        rangeStartOffset: 0,
        rangeEndOffset: Buffer.byteLength(code, 'utf8'),
        text: code,
        capabilities: ['callArguments'],
      },
    };

    const proc = spawnSync('php', [workerPath], {
      input: `${JSON.stringify(request)}\n`,
      encoding: 'utf8',
    });
    assert.equal(proc.status, 0, proc.stderr);
    const line = proc.stdout.trim().split(/\r?\n/).at(-1) ?? '';
    assert.notEqual(line, '');
    const response = JSON.parse(line) as {
      ok: boolean;
      result?: {
        callArguments?: Array<{
          callStartOffset: number;
          hints: Array<{ parameterName: string; hide: boolean }>;
        }>;
      };
    };
    assert.equal(response.ok, true);
    const calls = response.result?.callArguments ?? [];
    assert.ok(calls.length >= 2);
    const visibleNames = calls.flatMap((call) =>
      call.hints.filter((hint) => !hint.hide).map((hint) => hint.parameterName),
    );
    assert.ok(visibleNames.includes('format'));
    assert.ok(visibleNames.includes('value'));
  });

  it('returns hints for nested user-defined method calls', () => {
    const phpProbe = spawnSync('php', ['-v'], { encoding: 'utf8' });
    if (phpProbe.status !== 0) {
      return;
    }

    fs.mkdirSync(tmpRoot, { recursive: true });
    const phpFile = path.join(tmpRoot, 'nested-method.php');
    const code = `<?php
class C {
  public function outer(int $x, int $y): void {}
  public function inner(string $v): int { return 1; }
  public function test(): void {
    $this->outer(1, $this->inner('a'));
  }
}
`;
    fs.writeFileSync(phpFile, code, 'utf8');

    const request = {
      protocolVersion: 1,
      id: 'test-3',
      method: 'resolveNodeContext',
      params: {
        filePath: phpFile,
        cursorOffset: 0,
        rangeStartOffset: 0,
        rangeEndOffset: Buffer.byteLength(code, 'utf8'),
        text: code,
        capabilities: ['callArguments'],
      },
    };

    const proc = spawnSync('php', [workerPath], {
      input: `${JSON.stringify(request)}\n`,
      encoding: 'utf8',
    });
    assert.equal(proc.status, 0, proc.stderr);
    const line = proc.stdout.trim().split(/\r?\n/).at(-1) ?? '';
    assert.notEqual(line, '');
    const response = JSON.parse(line) as {
      ok: boolean;
      result?: {
        callArguments?: Array<{
          hints: Array<{ parameterName: string; hide: boolean }>;
        }>;
      };
    };
    assert.equal(response.ok, true);
    const visibleNames = (response.result?.callArguments ?? []).flatMap((call) =>
      call.hints.filter((hint) => !hint.hide).map((hint) => hint.parameterName),
    );
    assert.ok(visibleNames.includes('x'));
    assert.ok(visibleNames.includes('y'));
    assert.ok(visibleNames.includes('v'));
  });
});
