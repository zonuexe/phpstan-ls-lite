# Changelog

All notable changes of `phpstan-ls-lite` are documented in this file using the [Keep a Changelog](https://keepachangelog.com/) principles.

## Unreleased

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
