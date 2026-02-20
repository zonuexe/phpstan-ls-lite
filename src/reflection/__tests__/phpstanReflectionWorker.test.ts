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
});
