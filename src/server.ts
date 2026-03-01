#!/usr/bin/env node

import {
  createConnection,
  InlayHintKind,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node.js';
import type { InitializeParams, WorkspaceFolder } from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { resolvePhpstanRuntime } from './runtime/phpstanCommand.js';
import { createPhpProcessReflectionClient } from './reflection/phpstanReflectionClient.js';
import {
  createPhpstanDiagnosticsService,
  type PhpstanDiagnosticsSettings,
  type PhpstanDiagnosticsSettingsUpdate,
} from './diagnostics/phpstanDiagnostics.js';

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
const reflectionWorkerPath = fileURLToPath(
  new URL('../php/phpstan-reflection-worker.php', import.meta.url),
);
const reflectionClient = createPhpProcessReflectionClient({
  workerScriptPath: reflectionWorkerPath,
  logger: (message) => {
    connection.console.error(message);
  },
  loggerInfo: (message) => {
    connection.console.info(message);
  },
});
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

function utf16OffsetToUtf8ByteOffset(text: string, utf16Offset: number): number {
  const clamped = Math.max(0, Math.min(utf16Offset, text.length));
  return Buffer.byteLength(text.slice(0, clamped), 'utf8');
}

function utf8ByteOffsetToUtf16Offset(text: string, utf8ByteOffset: number): number {
  const bytes = Buffer.from(text, 'utf8');
  const clamped = Math.max(0, Math.min(utf8ByteOffset, bytes.length));
  return bytes.subarray(0, clamped).toString('utf8').length;
}

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

function filePathToUri(filePath: string): string {
  return pathToFileURL(filePath).toString();
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
      inlayHintProvider: true,
      hoverProvider: true,
      definitionProvider: true,
      renameProvider: true,
    },
  };
});

connection.onInitialized(() => {
  void logResolvedRuntimes();
  void reflectionClient.ping().then((ok) => {
    connection.console.info(`[reflection] worker health: ${ok ? 'ok' : 'failed'}`);
  });
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

connection.languages.inlayHint.on(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  const text = document.getText();
  const hints: {
    position: { line: number; character: number };
    label: string;
    kind: InlayHintKind;
    paddingRight: boolean;
  }[] = [];
  const filePath = workspaceUriToPath(params.textDocument.uri);
  if (!filePath) {
    return hints;
  }
  const rangeStartUtf16 = document.offsetAt(params.range.start);
  const rangeEndUtf16 = document.offsetAt(params.range.end);
  const reflection = await reflectionClient.resolveNodeContext({
    filePath,
    cursorOffset: rangeStartUtf16,
    rangeStartOffset: utf16OffsetToUtf8ByteOffset(text, rangeStartUtf16),
    rangeEndOffset: utf16OffsetToUtf8ByteOffset(text, rangeEndUtf16),
    text,
    capabilities: ['callArguments'],
  });
  for (const call of reflection?.callArguments ?? []) {
    for (const hint of call.hints) {
      if (hint.hide) {
        continue;
      }
      const utf16Offset = utf8ByteOffsetToUtf16Offset(text, hint.argumentStartOffset);
      const position = document.positionAt(utf16Offset);
      hints.push({
        position,
        label: `$${hint.parameterName}:`,
        kind: InlayHintKind.Parameter,
        paddingRight: true,
      });
    }
  }
  const dedup = new Map<string, (typeof hints)[number]>();
  for (const hint of hints) {
    const key = `${hint.position.line}:${hint.position.character}:${String(hint.label)}`;
    dedup.set(key, hint);
  }
  return [...dedup.values()];
});

connection.onHover(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }
  const filePath = workspaceUriToPath(params.textDocument.uri);
  if (!filePath) {
    return null;
  }
  const text = document.getText();
  const cursorUtf16 = document.offsetAt(params.position);
  const result = await reflectionClient.resolveNodeContext({
    filePath,
    cursorOffset: utf16OffsetToUtf8ByteOffset(text, cursorUtf16),
    text,
    capabilities: ['hover'],
  });
  if (!result?.hover) {
    return null;
  }
  return {
    contents: {
      kind: 'markdown',
      value: result.hover.markdown,
    },
  };
});

connection.onDefinition(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }
  const filePath = workspaceUriToPath(params.textDocument.uri);
  if (!filePath) {
    return null;
  }
  const text = document.getText();
  const cursorUtf16 = document.offsetAt(params.position);
  const result = await reflectionClient.resolveNodeContext({
    filePath,
    cursorOffset: utf16OffsetToUtf8ByteOffset(text, cursorUtf16),
    text,
    capabilities: ['definition'],
  });
  const definitions = result?.definitions ?? [];
  if (definitions.length === 0) {
    return null;
  }
  return definitions.map((definition) => ({
    uri: filePathToUri(definition.filePath),
    range: {
      start: { line: definition.line, character: definition.character },
      end: { line: definition.line, character: definition.character },
    },
  }));
});

connection.onRenameRequest(async (params) => {
  const filePath = workspaceUriToPath(params.textDocument.uri);
  if (!filePath) {
    return null;
  }
  let savedText = '';
  try {
    savedText = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const savedDocument = TextDocument.create(params.textDocument.uri, 'php', 0, savedText);
  const cursorUtf16 = savedDocument.offsetAt(params.position);
  const result = await reflectionClient.resolveNodeContext({
    filePath,
    cursorOffset: utf16OffsetToUtf8ByteOffset(savedText, cursorUtf16),
    text: savedText,
    newName: params.newName,
    capabilities: ['rename'],
  });
  const renameEdits = result?.renameEdits ?? [];
  if (renameEdits.length === 0) {
    return null;
  }

  return {
    changes: {
      [params.textDocument.uri]: renameEdits.map((edit) => ({
        range: {
          start: savedDocument.positionAt(
            utf8ByteOffsetToUtf16Offset(savedText, edit.startOffset),
          ),
          end: savedDocument.positionAt(utf8ByteOffsetToUtf16Offset(savedText, edit.endOffset)),
        },
        newText: edit.replacement,
      })),
    },
  };
});

connection.onDidChangeConfiguration((params) => {
  diagnosticsService.updateSettings(readSettingsFromPayload(params.settings));
});

connection.onShutdown(() => {
  reflectionClient.dispose();
  diagnosticsService.dispose();
});

documents.listen(connection);
connection.listen();

console.error('PHPStan LS Lite started!');
