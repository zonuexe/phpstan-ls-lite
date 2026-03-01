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

  it('returns definition for nested user-defined method call', () => {
    const phpProbe = spawnSync('php', ['-v'], { encoding: 'utf8' });
    if (phpProbe.status !== 0) {
      return;
    }

    fs.mkdirSync(tmpRoot, { recursive: true });
    const phpFile = path.join(tmpRoot, 'definition-nested-method.php');
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
    const innerCallOffset = Buffer.byteLength(code.slice(0, code.indexOf('$this->inner(') + 7), 'utf8');

    const request = {
      protocolVersion: 1,
      id: 'test-4',
      method: 'resolveNodeContext',
      params: {
        filePath: phpFile,
        cursorOffset: innerCallOffset,
        text: code,
        capabilities: ['definition'],
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
        definitions?: Array<{ filePath: string; line: number; character: number }>;
      };
    };
    assert.equal(response.ok, true);
    const definitions = response.result?.definitions ?? [];
    assert.ok(definitions.length > 0);
    assert.equal(definitions[0]?.filePath, phpFile);
  });

  it('returns definition for class name usage', () => {
    const phpProbe = spawnSync('php', ['-v'], { encoding: 'utf8' });
    if (phpProbe.status !== 0) {
      return;
    }

    fs.mkdirSync(tmpRoot, { recursive: true });
    const phpFile = path.join(tmpRoot, 'definition-class.php');
    const code = `<?php
class Target {}
class User {
  public function run(): void {
    $x = new Target();
  }
}
`;
    fs.writeFileSync(phpFile, code, 'utf8');
    const classUsageOffset = Buffer.byteLength(code.slice(0, code.indexOf('new Target(') + 5), 'utf8');

    const request = {
      protocolVersion: 1,
      id: 'test-5',
      method: 'resolveNodeContext',
      params: {
        filePath: phpFile,
        cursorOffset: classUsageOffset,
        text: code,
        capabilities: ['definition'],
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
        definitions?: Array<{ filePath: string; line: number; character: number }>;
      };
    };
    assert.equal(response.ok, true);
    const definitions = response.result?.definitions ?? [];
    assert.ok(definitions.length > 0);
    assert.equal(definitions[0]?.filePath, phpFile);
    assert.equal(definitions[0]?.line, 1);
  });

  it('returns definition for class const fetch usage', () => {
    const phpProbe = spawnSync('php', ['-v'], { encoding: 'utf8' });
    if (phpProbe.status !== 0) {
      return;
    }

    fs.mkdirSync(tmpRoot, { recursive: true });
    const phpFile = path.join(tmpRoot, 'definition-class-const-fetch.php');
    const code = `<?php
class Target {
  public const BAR = 1;
}
class User {
  public function run(): void {
    $a = Target::BAR;
    $b = Target::class;
  }
}
`;
    fs.writeFileSync(phpFile, code, 'utf8');

    const testOffsets = [
      Buffer.byteLength(code.slice(0, code.indexOf('Target::BAR') + 1), 'utf8'),
      Buffer.byteLength(code.slice(0, code.indexOf('Target::class') + 1), 'utf8'),
    ];

    for (const [index, cursorOffset] of testOffsets.entries()) {
      const request = {
        protocolVersion: 1,
        id: `test-6-${index}`,
        method: 'resolveNodeContext',
        params: {
          filePath: phpFile,
          cursorOffset,
          text: code,
          capabilities: ['definition'],
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
          definitions?: Array<{ filePath: string; line: number; character: number }>;
        };
      };
      assert.equal(response.ok, true);
      const definitions = response.result?.definitions ?? [];
      assert.ok(definitions.length > 0);
      assert.equal(definitions[0]?.filePath, phpFile);
      assert.equal(definitions[0]?.line, 1);
    }
  });

  it('returns definition for static method and static property usage', () => {
    const phpProbe = spawnSync('php', ['-v'], { encoding: 'utf8' });
    if (phpProbe.status !== 0) {
      return;
    }

    fs.mkdirSync(tmpRoot, { recursive: true });
    const phpFile = path.join(tmpRoot, 'definition-static-members.php');
    const code = `<?php
class Target {
  public static int $bar = 1;
  public static function baz(): void {}
}
class User {
  public function run(): void {
    $x = Target::$bar;
    Target::baz();
  }
}
`;
    fs.writeFileSync(phpFile, code, 'utf8');

    const testOffsets = [
      Buffer.byteLength(code.slice(0, code.indexOf('Target::$bar') + 9), 'utf8'),
      Buffer.byteLength(code.slice(0, code.indexOf('Target::baz(') + 9), 'utf8'),
    ];

    for (const [index, cursorOffset] of testOffsets.entries()) {
      const request = {
        protocolVersion: 1,
        id: `test-7-${index}`,
        method: 'resolveNodeContext',
        params: {
          filePath: phpFile,
          cursorOffset,
          text: code,
          capabilities: ['definition'],
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
          definitions?: Array<{ filePath: string; line: number; character: number }>;
        };
      };
      assert.equal(response.ok, true);
      const definitions = response.result?.definitions ?? [];
      assert.ok(definitions.length > 0);
      assert.equal(definitions[0]?.filePath, phpFile);
    }
  });

  it('returns rename edits for local variable in current scope', () => {
    const phpProbe = spawnSync('php', ['-v'], { encoding: 'utf8' });
    if (phpProbe.status !== 0) {
      return;
    }

    fs.mkdirSync(tmpRoot, { recursive: true });
    const phpFile = path.join(tmpRoot, 'rename-local-variable.php');
    const code = `<?php
function test(int $a): void {
  $x = $a + 1;
  $y = $x + $x;
  $fn = function () use ($x): int {
    return $x;
  };
}
`;
    fs.writeFileSync(phpFile, code, 'utf8');
    const cursorOffset = Buffer.byteLength(code.slice(0, code.indexOf('$x =') + 1), 'utf8');

    const request = {
      protocolVersion: 1,
      id: 'test-rename-1',
      method: 'resolveNodeContext',
      params: {
        filePath: phpFile,
        cursorOffset,
        text: code,
        newName: 'value',
        capabilities: ['rename'],
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
        renameEdits?: Array<{ startOffset: number; endOffset: number; replacement: string }>;
      };
    };
    assert.equal(response.ok, true);
    const edits = response.result?.renameEdits ?? [];
    assert.equal(edits.length, 3);
    assert.ok(edits.every((edit) => edit.replacement === 'value'));
  });
});
