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
import { createPhpstanDiagnosticsService } from './diagnostics/phpstanDiagnostics.js';

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
  notifyError: (message) => {
    void connection.window.showErrorMessage(message);
  },
});
let workspaceFolders: WorkspaceFolder[] = [];
let supportsWorkspaceFolderChange = false;

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
    },
  };
});

connection.onInitialized(() => {
  void logResolvedRuntimes();
  for (const folder of workspaceFolders) {
    const folderPath = workspaceUriToPath(folder.uri);
    if (!folderPath) {
      continue;
    }
    diagnosticsService.analyzeWorkspace(folderPath);
  }
  if (supportsWorkspaceFolderChange) {
    connection.workspace.onDidChangeWorkspaceFolders((event) => {
      const removedUris = new Set(event.removed.map((folder) => folder.uri));
      const kept = workspaceFolders.filter((folder) => !removedUris.has(folder.uri));
      workspaceFolders = [...kept, ...event.added];
      void logResolvedRuntimes();
      for (const folder of event.added) {
        const folderPath = workspaceUriToPath(folder.uri);
        if (!folderPath) {
          continue;
        }
        diagnosticsService.analyzeWorkspace(folderPath);
      }
    });
  }
});

documents.onDidOpen((event) => {
  diagnosticsService.schedule(event.document);
});

documents.onDidChangeContent((event) => {
  diagnosticsService.schedule(event.document);
});

documents.onDidSave((event) => {
  diagnosticsService.schedule(event.document);
});

documents.onDidClose((event) => {
  diagnosticsService.clear(event.document.uri);
});

connection.onShutdown(() => {
  diagnosticsService.dispose();
});

documents.listen(connection);
connection.listen();

console.error('PHPStan LS Lite started!');
