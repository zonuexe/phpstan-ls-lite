# phpstan-ls-lite

This is an unofficial, lightweight language server that wraps PHPStan.

The project focuses on:

- compact and maintainable implementation with clear, predictable structure
- practical features with as little overhead as possible
- aiming for as-complete-as-possible support of the latest PHPStan

## Status (v0.0.3)

Current implementation focuses on diagnostics and runtime detection.

### Implemented

- LSP server over stdio
- PHPStan runtime detection from `composer.json`:
  1. `scripts.phpstan`
  2. `config.vendor-dir` + `bin/phpstan`
  3. default `vendor/bin/phpstan`
  4. `bamarni/composer-bin-plugin` (`vendor-bin` or custom target directory)
- Incremental diagnostics on:
  - `textDocument/didOpen`
  - `textDocument/didChange`
  - `textDocument/didSave`
- Editor Mode execution when supported:
  - `--tmp-file`
  - `--instead-of`
- Sequential analysis queue to avoid overlapping runs

### Not Yet Implemented

- Hover
- Code actions
- Completion

## Requirements

- Node.js 22+ (recommended)
- PHP 8.2+
- PHPStan available in your project (recommended via Composer)

## Run with npx

After publishing to npm, start the language server with:

```bash
npx --yes @zonuexe/phpstan-ls-lite
```

The server communicates via stdio.

## Example Client Configuration

### Neovim (`lspconfig`)

```lua
require('lspconfig').phpstan_ls_lite.setup({
  cmd = { 'npx', '--yes', '@zonuexe/phpstan-ls-lite' },
  filetypes = { 'php' },
  root_dir = require('lspconfig.util').root_pattern('composer.json', '.git'),
})
```

### VS Code (`package.json` snippet)

```json
{
  "contributes": {
    "languages": [{ "id": "php", "extensions": [".php"] }]
  },
  "activationEvents": ["onLanguage:php"],
  "main": "./out/extension.js"
}
```

```ts
new LanguageClient(
  "phpstan-ls-lite",
  "PHPStan LS Lite",
  { command: "npx", args: ["--yes", "@zonuexe/phpstan-ls-lite"] },
  { documentSelector: [{ language: "php" }] }
);
```

## Client Settings

The server accepts settings from both `initialize.initializationOptions` and
`workspace/didChangeConfiguration`.

Supported keys:

- `enableDiagnostics: boolean`
- `runOnDidSaveOnly: boolean`
- `phpstan.extraArgs: string[]`
- `phpstan.commandOverride: { command: string; args?: string[] } | null`

Accepted roots for these keys:

- top-level object
- `phpstanLsLite`
- `@zonuexe/phpstan-ls-lite`
- `settings`

Example:

```json
{
  "phpstanLsLite": {
    "enableDiagnostics": true,
    "runOnDidSaveOnly": false,
    "phpstan": {
      "extraArgs": ["--memory-limit=1G"],
      "commandOverride": null
    }
  }
}
```

## Copyright

This project is licensed under the [MPL 2.0].

```
Copyright (C) 2026  USAMI Kenta

This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
```

[MPL 2.0]: https://www.mozilla.org/en-US/MPL/2.0/
