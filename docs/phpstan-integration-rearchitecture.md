# PHPStan Integration Rearchitecture (Rector-Inspired)

## Background

Current `php/phpstan-reflection-worker.php` works, but it directly touches several PHPStan internals:

- `PHPStan\DependencyInjection\ContainerFactory`
- `PHPStan\Analyser\NodeScopeResolver`
- `PHPStan\Analyser\ScopeFactory`
- parser service IDs

This is fragile across PHPStan updates, even if functionality is correct today.

In `/Users/megurine/repo/php/rector-src`, Rector uses a wrapper approach:

- keep direct/internal PHPStan calls in a narrow integration layer
- expose stable, project-level services for the rest of the code
- consume `Scope` / `ReflectionProvider` APIs in feature code

## Goal

Keep precision powered by PHPStan (`Scope::getType()`, `ReflectionProvider`) while reducing direct internal coupling and upgrade risk.

## Proposed Architecture

### 1. Split into Integration Layer + Feature Layer

- `php/bridge/PhpstanRuntimeBootstrapper.php`
  - responsibility: initialize PHPStan runtime/container once per project root
  - owns internal APIs (`ContainerFactory`, parser service lookup)
- `php/bridge/ScopedAstProvider.php`
  - responsibility: parse text and run scope pipeline (`processNodes`)
  - returns immutable query context (`stmts`, callback-capable scope runner)
- `php/feature/DefinitionQuery.php`
- `php/feature/HoverQuery.php`
- `php/feature/InlayHintQuery.php`
  - responsibility: feature logic only (no container bootstrapping)
  - input: stable interfaces (`ReflectionProvider`, scoped-node callback)

This mirrors Rector’s `PHPStanNodeScopeResolver` + resolvers split.

### 1.5 Avoid direct instantiation in feature flow

Current direct instantiations to phase out from worker logic:

- `new OutOfClassScope()` (already removed)
- `new ContainerFactory(...)` in feature path

Rule:

- direct `new` is allowed only inside integration/bootstrap classes
- feature/query classes must be constructor-injected with interfaces

### 2. Define local stable interfaces

Introduce project-owned interfaces and make worker depend on them:

- `PhpstanRuntimeProviderInterface`
  - `getRuntime(string $filePath): ?PhpstanRuntime`
- `ScopedNodeProcessorInterface`
  - `process(string $filePath, string $text, callable(Node, Scope): void): bool`

Internals stay behind implementations. Feature code no longer imports `ContainerFactory` or parser service names.

### 3. Keep PHPStan-first data model

- Type info: always `Scope::getType()`
- Symbol existence/resolution: always `ReflectionProvider` and scope name resolution
- Local line mapping fallback: AST index (for same-file definitions and members)

This preserves the project’s core promise: precise PHPStan-based types.

### 3.5 File cache strategy (Rector/PHPStan style)

Use file cache more aggressively at two levels.

1. PHPStan runtime/container cache (already partially leveraged)
   - Keep per-root stable tmp/cache directory:
     - `${sys_tmp}/phpstan-ls-lite/{root_hash}`
   - This lets PHPStan reuse compiled container and internal caches.

2. Bridge-level query cache (new)
   - Add `CacheStorageInterface` abstraction with:
     - `FileCacheStorage` (default)
     - `MemoryCacheStorage` (optional, CI/dev)
   - Cache payloads for expensive derived data:
     - local definition index
     - call-argument mapping for unchanged document snapshots
   - Key format:
     - `{projectRootHash}:{feature}:{filePathHash}:{contentHash}:{configHash}:{phpstanVersion}`
   - Invalidate when:
     - document content hash changes
     - composer.lock / phpstan.neon(.dist) hash changes
     - runtime/phpstan version changes

## Can we use PHPStan cache directly?

Short answer: **yes, partially**.

- Confirmed: `PHPStan\Cache\Cache` can be resolved from PHPStan DI container.
- Confirmed: `PHPStan\Cache\FileCacheStorage` and `MemoryCacheStorage` exist and are usable through that service.
- Limitation: these cache classes are not marked `@api` (unlike `ResultCacheMetaExtension`), so direct dependency has upgrade risk.

### Practical recommendation

Use a hybrid strategy:

1. Preferred path: use container-provided `PHPStan\Cache\Cache` when available.
2. Fallback path: use project-owned `FileCacheStorage` with compatible keying/serialization.

This gives immediate performance gains while keeping an escape hatch if internal PHPStan cache wiring changes.

### What to cache via PHPStan cache first

- `local_definition_index` per `(root, file, contentHash, configHash, phpstanVersion)`
- `callArguments` payload per `(root, file, range, contentHash, configHash, phpstanVersion)`

Avoid caching hover markdown initially (cheap enough and more volatile by cursor context).

### 4. Optional second backend (later)

Add a second backend path that uses PHPStan extension points more directly (custom command / formatter) and make backend selectable:

- `backend=legacy-reflection` (current behavior)
- `backend=extension-driven` (future)

This allows gradual migration without breaking LSP behavior.

## Migration Plan

### Phase 1 (safe refactor, no behavior change)

1. Extract runtime bootstrap/cache from `phpstan-reflection-worker.php` into `PhpstanRuntimeBootstrapper`.
2. Extract scope processing into `ScopedAstProvider`.
3. Move `hover` / `inlay` / `definition` resolution into separate query classes.
4. Keep JSON protocol unchanged.

Additionally:

5. Introduce `CacheStorageInterface` and a small file-cache implementation.
6. Start by caching only local definition index and call-argument mapping (lowest risk).

### Phase 2 (behavior hardening)

1. Add integration tests that pin:
   - nested call inlay hints
   - method/class/static-property/class-const definition
   - hover from `$scope->getType()`
2. Add adapter-level tests with fake runtime provider to decouple feature tests from container internals.

### Phase 3 (optional extension-driven backend)

1. Prototype extension-driven query command.
2. Benchmark against current bridge latency and memory.
3. Keep both backends until extension path proves stable.

### Phase 4 (cache hardening)

1. Add cache metrics logging (hit/miss, deserialize cost).
2. Add stale-lock cleanup and max-size policy.
3. Add `clear-cache` command or LSP admin request for troubleshooting.

## Design Rules

- Feature query classes must not call `ContainerFactory` directly.
- `ContainerFactory` and parser service IDs are allowed only in integration layer.
- Feature classes should consume:
  - `Scope`
  - `ReflectionProvider`
  - `Type`
  - PhpParser nodes
- Prefer same-file AST location for line-accurate jump.
- Prefer reflection for cross-file/class existence.
- Cache keys must include config/runtime fingerprints to avoid stale cross-project reuse.

## Immediate Next Step

Start Phase 1 by extracting the runtime bootstrap/cache logic first (lowest-risk, highest isolation gain).
