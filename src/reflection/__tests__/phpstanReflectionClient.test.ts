import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPingRequest,
  buildResolveNodeContextRequest,
  parseReflectionResponse,
} from '../phpstanReflectionClient.js';

describe('buildPingRequest', () => {
  it('builds a ping request with protocol version', () => {
    const req = buildPingRequest();
    assert.equal(req.protocolVersion, 1);
    assert.equal(req.method, 'ping');
    assert.equal(typeof req.id, 'string');
    assert.ok(req.id.length > 0);
  });
});

describe('buildResolveNodeContextRequest', () => {
  it('builds resolveNodeContext request payload', () => {
    const req = buildResolveNodeContextRequest({
      filePath: '/tmp/a.php',
      cursorOffset: 42,
      capabilities: ['hover', 'callArguments'],
      text: '<?php echo 1;',
    });
    assert.equal(req.method, 'resolveNodeContext');
    assert.equal(req.params.filePath, '/tmp/a.php');
    assert.equal(req.params.cursorOffset, 42);
    assert.deepEqual(req.params.capabilities, ['hover', 'callArguments']);
  });
});

describe('parseReflectionResponse', () => {
  it('parses valid response', () => {
    const parsed = parseReflectionResponse(
      JSON.stringify({
        protocolVersion: 1,
        id: 'abc',
        ok: true,
        result: {},
      }),
    );
    assert.ok(parsed);
    assert.equal(parsed?.ok, true);
    assert.equal(parsed?.id, 'abc');
  });

  it('returns null for invalid response payload', () => {
    assert.equal(parseReflectionResponse('not json'), null);
    assert.equal(
      parseReflectionResponse(
        JSON.stringify({
          protocolVersion: 2,
          id: 'abc',
          ok: true,
        }),
      ),
      null,
    );
  });
});
