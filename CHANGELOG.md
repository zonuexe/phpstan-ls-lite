# Changelog

All notable changes of `phpstan-ls-lite` are documented in this file using the [Keep a Changelog](https://keepachangelog.com/) principles.

<!-- ## Unreleased -->

## 0.0.4 - 2026-03-04

### Added

 * `textDocument/definition` support backed by PHPStan reflection.
 * `textDocument/rename` support for local variable renames in the current file.
 * `info` subcommand to print runtime details from the current directory:
   * server version and server path
   * PHP version and PHP binary path
   * detected PHPStan runtime path/source/args and PHPStan version
 * `--version` CLI flag.

### Changed

 * LSP transport selection is now explicit at startup; use one of:
   * `--stdio`
   * `--pipe <name>` / `--pipe=<name>`
   * `--socket <port>` / `--socket=<port>`
   * `--node-ipc`
   Running without transport flags now prints help and exits.
 * Improved reflection-side caching to reduce repeated analysis cost for interactive features.

### Fixed

 * Better diagnostics fallback for unsaved buffers with PHP syntax errors by re-running analysis against the saved file.

## 0.0.3 - 2026-02-20

### Added

 * Client-configurable diagnostics behavior via `initialize.initializationOptions` and `workspace/didChangeConfiguration`.
 * New settings:
   * `enableDiagnostics`
   * `runOnDidSaveOnly`
   * `phpstan.extraArgs`
   * `phpstan.commandOverride`
 * Stub support for `textDocument/documentSymbol` and `textDocument/completion` (returns empty results instead of unhandled-method noise).

### Changed

 * Removed startup full-project analysis; diagnostics now run per-document from open/change/save events.
 * Inlay hints and hover now prioritize PHPStan-based analysis paths (Scope/Reflection) instead of local heuristic parsing.
 * Reflection worker now uses PHPStan RichParser for interactive features so method/function bodies are analyzed.

### Fixed

 * Improved diagnostics fallback when PHPStan exits with errors by surfacing execution-failure diagnostics.
 * Added support for top-level PHPStan JSON `errors` as diagnostics when file-level messages are unavailable.
 * Fixed missing inlay hints in real projects where SimpleParser omitted call sites.

## 0.0.2 - 2026-02-19

### Fixed

 * Corrected npm executable metadata (`bin`) for scoped package distribution.
 * Updated package metadata so `npx @zonuexe/phpstan-ls-lite` resolves the CLI entrypoint.

## 0.0.1 - 2026-02-19

### Added

 * Language Server Protocol server over stdio.
 * PHPStan runtime detection from `composer.json` with the following priority:
   * `scripts.phpstan`
   * `config.vendor-dir` + `bin/phpstan`
   * default `vendor/bin/phpstan`
   * `bamarni/composer-bin-plugin` target (`vendor-bin` or custom target directory)
 * Startup full-project analysis on workspace initialization.
 * Incremental diagnostics on `didOpen`, `didChange`, and `didSave`.
 * Sequential analysis queue to avoid overlapping PHPStan executions.
 * Editor Mode support (`--tmp-file`, `--instead-of`) when supported by installed PHPStan version.
 * Runtime/source-aware diagnostics logging with masked sensitive command arguments.
