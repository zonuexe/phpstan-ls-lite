import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _internal } from '../phpstanDiagnostics.js';

describe('extractDiagnosticsForFile', () => {
  it('maps phpstan json messages to LSP diagnostics', () => {
    const output = JSON.stringify({
      files: {
        '/repo/src/Foo.php': {
          messages: [
            {
              message: 'Parameter $x has invalid type.',
              line: 10,
              identifier: 'parameter.type',
              tip: 'Use int',
            },
          ],
        },
      },
    });

    const diagnostics = _internal.extractDiagnosticsForFile(output, '/repo/src/Foo.php', '/repo');
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.source, 'phpstan');
    assert.equal(diagnostics[0]?.range.start.line, 9);
    assert.match(diagnostics[0]?.message ?? '', /identifier: parameter\.type/);
    assert.match(diagnostics[0]?.message ?? '', /tip: Use int/);
  });

  it('handles relative file paths in phpstan output', () => {
    const output = JSON.stringify({
      files: {
        'src/Foo.php': {
          messages: [{ message: 'Error', line: 1 }],
        },
      },
    });

    const diagnostics = _internal.extractDiagnosticsForFile(output, '/repo/src/Foo.php', '/repo');
    assert.equal(diagnostics.length, 1);
  });

  it('returns empty array for invalid output', () => {
    const diagnostics = _internal.extractDiagnosticsForFile('not-json', '/repo/src/Foo.php', '/repo');
    assert.deepEqual(diagnostics, []);
  });
});

