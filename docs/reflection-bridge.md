# Reflection Bridge Strategy

## Goal

Collect symbol/type metadata from PHPStan Reflection with low overhead and reuse it for:

- `textDocument/hover`
- `textDocument/inlayHint` (parameter name hints)

For the rearchitecture plan that isolates PHPStan internals behind adapters,
see `docs/phpstan-integration-rearchitecture.md`.

## Why a Bridge Process

Running `phpstan analyze` for every interactive feature is too expensive.
The bridge process keeps PHPStan bootstrapped and answers focused queries.

Benefits:

- amortized startup cost (single PHP process per workspace)
- shared reflection cache for hover + inlay hints
- deterministic JSON payloads for Node LSP server

## Transport

- Node launches a per-workspace PHP worker.
- Use stdio JSON lines (one JSON object per line) for simplicity.
- Request/response schema is versioned (`protocolVersion`).

## Recommended Query Shape

Use one request to fetch both hover and inlay-related data:

- request: `resolveNodeContext`
- input:
  - file path
  - current buffer content (optional; temp-file mode)
  - cursor/range
  - requested capabilities (`hover`, `callArguments`)
- output:
  - hover payload (render-ready text or structured type info)
  - call-site argument mapping:
    - parameter names by index
    - per-argument named/same-variable suppression flags

This avoids duplicate parsing/reflection for `hover` and `inlayHint`.

## Fallback Strategy

If direct Reflection integration is blocked, use the existing hover-tree extraction
approach (similar to `phpstan-hover-tree-fetcher.php`) and extend its output to include:

- call expression
- resolved function/method signature
- argument-to-parameter mapping

Then Node can derive inlay hints with the same suppression rules.

## Phased Implementation

1. Protocol and client abstraction in Node (no behavior change yet).
2. PHP worker scaffold with health check (`ping`).
3. `resolveNodeContext` for hover.
4. Extend response with call argument mapping and wire `inlayHint`.
5. Add cache invalidation keyed by document version and project config hash.

## Runtime Constraints

- hard timeout per request (default 1500ms)
- restart worker on crash
- bounded in-memory cache (LRU)
- never block diagnostics queue; interactive features should degrade gracefully
