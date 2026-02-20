#!/usr/bin/env node

import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node.js';
import type { InitializeParams, WorkspaceFolder } from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolvePhpstanRuntime } from './runtime/phpstanCommand.js';
import {
  createPhpstanDiagnosticsService,
  type PhpstanDiagnosticsSettings,
  type PhpstanDiagnosticsSettingsUpdate,
} from './diagnostics/phpstanDiagnostics.js';

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
const diagnosticsService = createPhpstanDiagnosticsService({
  publishDiagnostics: (uri, diagnostics) => {
    connection.sendDiagnostics({ uri, diagnostics });
  },
  logger: (message) => {
    connection.console.error(message);
  },
  loggerInfo: (message) => {
    connection.console.info(message);
  },
});
let workspaceFolders: WorkspaceFolder[] = [];
let supportsWorkspaceFolderChange = false;

function parseCommandOverride(
  value: unknown,
): PhpstanDiagnosticsSettings['phpstan']['commandOverride'] | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const raw = value as { command?: unknown; args?: unknown };
  if (typeof raw.command !== 'string' || raw.command.length === 0) {
    return undefined;
  }
  if (!Array.isArray(raw.args)) {
    return { command: raw.command };
  }
  const args = raw.args.filter((arg): arg is string => typeof arg === 'string');
  return { command: raw.command, args };
}

function parseDiagnosticsSettings(value: unknown): PhpstanDiagnosticsSettingsUpdate {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const raw = value as {
    enableDiagnostics?: unknown;
    runOnDidSaveOnly?: unknown;
    phpstan?: {
      extraArgs?: unknown;
      commandOverride?: unknown;
    };
  };
  const result: PhpstanDiagnosticsSettingsUpdate = {};
  if (typeof raw.enableDiagnostics === 'boolean') {
    result.enableDiagnostics = raw.enableDiagnostics;
  }
  if (typeof raw.runOnDidSaveOnly === 'boolean') {
    result.runOnDidSaveOnly = raw.runOnDidSaveOnly;
  }
  const phpstanSettings: NonNullable<PhpstanDiagnosticsSettingsUpdate['phpstan']> = {};
  if (Array.isArray(raw.phpstan?.extraArgs)) {
    phpstanSettings.extraArgs = raw.phpstan.extraArgs.filter(
      (arg): arg is string => typeof arg === 'string',
    );
  }
  const commandOverride = parseCommandOverride(raw.phpstan?.commandOverride);
  if (commandOverride !== undefined) {
    phpstanSettings.commandOverride = commandOverride;
  }
  if (Object.keys(phpstanSettings).length > 0) {
    result.phpstan = phpstanSettings;
  }
  return result;
}

function readSettingsFromPayload(payload: unknown): PhpstanDiagnosticsSettingsUpdate {
  if (!payload || typeof payload !== 'object') {
    return {};
  }
  const raw = payload as {
    phpstanLsLite?: unknown;
    ['@zonuexe/phpstan-ls-lite']?: unknown;
    settings?: unknown;
  };
  const direct = parseDiagnosticsSettings(payload);
  const scoped = parseDiagnosticsSettings(raw.phpstanLsLite);
  const scopedByName = parseDiagnosticsSettings(raw['@zonuexe/phpstan-ls-lite']);
  const nested = parseDiagnosticsSettings(raw.settings);
  return {
    ...direct,
    ...scoped,
    ...scopedByName,
    ...nested,
    phpstan: {
      ...direct.phpstan,
      ...scoped.phpstan,
      ...scopedByName.phpstan,
      ...nested.phpstan,
    },
  };
}

function workspaceUriToPath(uri: string): string | null {
  try {
    if (!uri.startsWith('file://')) {
      return null;
    }
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

async function logResolvedRuntimes(): Promise<void> {
  for (const folder of workspaceFolders) {
    const folderPath = workspaceUriToPath(folder.uri);
    if (!folderPath) {
      continue;
    }
    const probePath = path.join(folderPath, 'composer.json');
    const resolved = await resolvePhpstanRuntime(probePath);
    if (resolved.kind === 'detected') {
      const runtime = resolved.runtime;
      connection.console.info(
        `[runtime] ${folder.name}: detected from ${runtime.source} (${runtime.kind === 'file' ? runtime.executablePath : runtime.command})`,
      );
      continue;
    }
    connection.console.info(
      `[runtime] ${folder.name}: fallback command '${resolved.runtime.command}'`,
    );
  }
}

connection.onInitialize((params: InitializeParams) => {
  supportsWorkspaceFolderChange = params.capabilities.workspace?.workspaceFolders === true;
  diagnosticsService.updateSettings(readSettingsFromPayload(params.initializationOptions));

  if (params.workspaceFolders && params.workspaceFolders.length > 0) {
    workspaceFolders = params.workspaceFolders;
  } else if (params.rootUri) {
    workspaceFolders = [{ uri: params.rootUri, name: 'root' }];
  } else {
    workspaceFolders = [];
  }
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        save: true,
      },
      documentSymbolProvider: true,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ['$', '-', '>'],
      },
    },
  };
});

connection.onInitialized(() => {
  void logResolvedRuntimes();
  if (supportsWorkspaceFolderChange) {
    connection.workspace.onDidChangeWorkspaceFolders((event) => {
      const removedUris = new Set(event.removed.map((folder) => folder.uri));
      const kept = workspaceFolders.filter((folder) => !removedUris.has(folder.uri));
      workspaceFolders = [...kept, ...event.added];
      void logResolvedRuntimes();
    });
  }
});

documents.onDidOpen((event) => {
  diagnosticsService.schedule(event.document, 'open');
});

documents.onDidChangeContent((event) => {
  diagnosticsService.schedule(event.document, 'change');
});

documents.onDidSave((event) => {
  diagnosticsService.schedule(event.document, 'save');
});

documents.onDidClose((event) => {
  diagnosticsService.clear(event.document.uri);
});

connection.onDocumentSymbol(() => {
  return [];
});

connection.onCompletion(() => {
  return [];
});

connection.onDidChangeConfiguration((params) => {
  diagnosticsService.updateSettings(readSettingsFromPayload(params.settings));
});

connection.onShutdown(() => {
  diagnosticsService.dispose();
});

documents.listen(connection);
connection.listen();

console.error('PHPStan LS Lite started!');
