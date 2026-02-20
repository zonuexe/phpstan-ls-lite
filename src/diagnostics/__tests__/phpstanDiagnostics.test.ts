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
    const diagnostics = _internal.extractDiagnosticsForFile(
      'not-json',
      '/repo/src/Foo.php',
      '/repo',
    );
    assert.deepEqual(diagnostics, []);
  });

  it('extracts diagnostics for all files from project output', () => {
    const output = JSON.stringify({
      files: {
        '/repo/src/Foo.php': {
          messages: [{ message: 'Foo error', line: 2 }],
        },
        'src/Bar.php': {
          messages: [{ message: 'Bar error', line: 3 }],
        },
      },
    });
    const byFile = _internal.extractDiagnosticsByFile(output, '/repo');
    assert.ok(byFile);
    assert.equal(byFile?.get('/repo/src/Foo.php')?.length, 1);
    assert.equal(byFile?.get('/repo/src/Bar.php')?.length, 1);
  });
});

describe('formatCommandForLog', () => {
  it('masks sensitive args', () => {
    const text = _internal.formatCommandForLog('phpstan', [
      'analyze',
      '--api-key',
      'abc123',
      '--token=xyz',
      '--memory-limit=1G',
    ]);
    assert.equal(text, 'phpstan analyze --api-key *** --token=*** --memory-limit=1G');
  });
});

describe('createExecutionFailureDiagnostic', () => {
  it('creates a synthetic diagnostic from stderr', () => {
    const diagnostic = _internal.createExecutionFailureDiagnostic(
      1,
      '\nIn TcpServer.php line 167:\nFailed to listen\n',
    );
    assert.equal(diagnostic.source, 'phpstan-ls-lite');
    assert.match(diagnostic.message, /PHPStan execution failed/);
    assert.match(diagnostic.message, /In TcpServer.php line 167/);
    assert.equal(diagnostic.range.start.line, 0);
  });
});

describe('extractGlobalErrors', () => {
  it('converts top-level phpstan errors to diagnostics', () => {
    const diagnostics = _internal.extractGlobalErrors(
      JSON.stringify({
        files: {},
        errors: ['Internal error happened'],
      }),
    );
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.source, 'phpstan');
    assert.match(diagnostics[0]?.message ?? '', /Internal error happened/);
  });
});

describe('hasPhpSyntaxError', () => {
  it('detects syntax error text from stderr', () => {
    assert.equal(
      _internal.hasPhpSyntaxError('', 'PHP Parse error: syntax error, unexpected token ";"'),
      true,
    );
  });

  it('returns false when output does not contain parse markers', () => {
    assert.equal(_internal.hasPhpSyntaxError('{"files":{}}', ''), false);
  });
});
