import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Diagnostic, DiagnosticSeverity, TextDocument } from 'vscode-languageserver/node.js';
import {
  buildPhpstanAnalyzeCommand,
  resolvePhpstanRuntime,
  type PhpstanAnalyzeCommand,
  type ResolvedPhpstanRuntime,
} from '../runtime/phpstanCommand.js';
import {
  applyEditorModeArgs,
  applyTempFileFallbackArgs,
  getPhpstanVersionCommand,
  isPhpstanEditorModeSupported,
} from '../runtime/phpstanEditorMode.js';

type PhpstanMessage = {
  message?: unknown;
  line?: unknown;
  identifier?: unknown;
  tip?: unknown;
};

type PhpstanFileEntry = {
  messages?: unknown;
};

type PhpstanJsonOutput = {
  files?: Record<string, PhpstanFileEntry>;
};

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

type PublishDiagnostics = (uri: string, diagnostics: Diagnostic[]) => void;
type LogMessage = (message: string) => void;

export type PhpstanDiagnosticsService = {
  analyzeWorkspace(workspacePath: string): void;
  schedule(document: TextDocument): void;
  clear(uri: string): void;
  dispose(): void;
};

const DEFAULT_DEBOUNCE_MS = 250;

function uriToFilePath(uri: string): string | null {
  try {
    if (!uri.startsWith('file://')) {
      return null;
    }
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function normalizePath(value: string): string {
  return path.normalize(value);
}

function filePathToUri(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

function runProcess(commandSpec: PhpstanAnalyzeCommand | { command: string; args: string[]; cwd: string }): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(commandSpec.command, commandSpec.args, {
      cwd: commandSpec.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
    child.on('error', (error) => {
      resolve({ code: -1, stdout, stderr: `${stderr}\n${String(error)}` });
    });
  });
}

function normalizeFileEntries(
  output: PhpstanJsonOutput,
  cwd: string,
): Map<string, PhpstanFileEntry> {
  const map = new Map<string, PhpstanFileEntry>();
  const files = output.files ?? {};
  for (const [filePath, entry] of Object.entries(files)) {
    const normalized = path.isAbsolute(filePath)
      ? normalizePath(filePath)
      : normalizePath(path.resolve(cwd, filePath));
    map.set(normalized, entry);
  }
  return map;
}

function toDiagnostic(messageEntry: PhpstanMessage): Diagnostic | null {
  if (typeof messageEntry.message !== 'string' || messageEntry.message.length === 0) {
    return null;
  }
  const rawLine = typeof messageEntry.line === 'number' ? messageEntry.line : 1;
  const line = Math.max(0, rawLine - 1);
  const notes: string[] = [];
  if (typeof messageEntry.identifier === 'string' && messageEntry.identifier.length > 0) {
    notes.push(`identifier: ${messageEntry.identifier}`);
  }
  if (typeof messageEntry.tip === 'string' && messageEntry.tip.length > 0) {
    notes.push(`tip: ${messageEntry.tip}`);
  }
  const suffix = notes.length > 0 ? `\n${notes.join('\n')}` : '';
  return {
    severity: 1 as DiagnosticSeverity,
    range: {
      start: { line, character: 0 },
      end: { line, character: 1 },
    },
    message: `${messageEntry.message}${suffix}`,
    source: 'phpstan',
  };
}

function extractDiagnosticsForFile(
  outputText: string,
  targetFilePath: string,
  cwd: string,
): Diagnostic[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const output = parsed as PhpstanJsonOutput;
  const normalizedTarget = normalizePath(targetFilePath);
  const entries = normalizeFileEntries(output, cwd);
  const fileEntry = entries.get(normalizedTarget);
  if (!fileEntry || !Array.isArray(fileEntry.messages)) {
    return [];
  }
  const diagnostics: Diagnostic[] = [];
  for (const entry of fileEntry.messages) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const diagnostic = toDiagnostic(entry as PhpstanMessage);
    if (diagnostic) {
      diagnostics.push(diagnostic);
    }
  }
  return diagnostics;
}

function extractDiagnosticsByFile(
  outputText: string,
  cwd: string,
): Map<string, Diagnostic[]> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const output = parsed as PhpstanJsonOutput;
  const entries = normalizeFileEntries(output, cwd);
  const diagnosticsByFile = new Map<string, Diagnostic[]>();
  for (const [filePath, entry] of entries.entries()) {
    if (!Array.isArray(entry.messages)) {
      diagnosticsByFile.set(filePath, []);
      continue;
    }
    const diagnostics: Diagnostic[] = [];
    for (const message of entry.messages) {
      if (!message || typeof message !== 'object') {
        continue;
      }
      const diagnostic = toDiagnostic(message as PhpstanMessage);
      if (diagnostic) {
        diagnostics.push(diagnostic);
      }
    }
    diagnosticsByFile.set(filePath, diagnostics);
  }
  return diagnosticsByFile;
}

async function createTempPhpFile(content: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'phpstan-ls-lite-'));
  const filePath = path.join(dir, 'buffer.php');
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

async function cleanupTempPhpFile(filePath: string): Promise<void> {
  await rm(path.dirname(filePath), { recursive: true, force: true });
}

async function detectEditorMode(
  resolvedRuntime: ResolvedPhpstanRuntime,
  versionSupportCache: Map<string, boolean>,
): Promise<boolean> {
  const versionCommand = getPhpstanVersionCommand(resolvedRuntime);
  const cacheKey = `${versionCommand.cwd}::${versionCommand.command}`;
  const cached = versionSupportCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const result = await runProcess(versionCommand);
  const supported = result.code === 0 && isPhpstanEditorModeSupported(result.stdout);
  versionSupportCache.set(cacheKey, supported);
  return supported;
}

async function buildAnalyzeCommandForDocument(
  resolvedRuntime: ResolvedPhpstanRuntime,
  filePath: string,
  content: string,
  versionSupportCache: Map<string, boolean>,
): Promise<{ command: PhpstanAnalyzeCommand; tempFilePath: string }> {
  const tempFilePath = await createTempPhpFile(content);
  const baseCommand = buildPhpstanAnalyzeCommand({
    resolvedRuntime,
    targets: [filePath],
    errorFormat: 'json',
  });
  const editorModeSupported = await detectEditorMode(resolvedRuntime, versionSupportCache);
  if (editorModeSupported) {
    return {
      command: applyEditorModeArgs(baseCommand, tempFilePath, filePath),
      tempFilePath,
    };
  }
  return {
    command: applyTempFileFallbackArgs(baseCommand, tempFilePath),
    tempFilePath,
  };
}

export function createPhpstanDiagnosticsService(params: {
  publishDiagnostics: PublishDiagnostics;
  logger?: LogMessage;
  notifyError?: (message: string) => void;
  debounceMs?: number;
}): PhpstanDiagnosticsService {
  const {
    publishDiagnostics,
    logger = () => undefined,
    notifyError = () => undefined,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  } = params;
  const timers = new Map<string, NodeJS.Timeout>();
  const versions = new Map<string, number>();
  const versionSupportCache = new Map<string, boolean>();
  const workspaceScansInFlight = new Set<string>();

  async function runWorkspaceAnalysis(workspacePath: string): Promise<void> {
    if (workspaceScansInFlight.has(workspacePath)) {
      return;
    }
    workspaceScansInFlight.add(workspacePath);
    try {
      const resolvedRuntime = await resolvePhpstanRuntime(workspacePath);
      const command = buildPhpstanAnalyzeCommand({
        resolvedRuntime,
        targets: [resolvedRuntime.workingDirectory],
        errorFormat: 'json',
      });
      const result = await runProcess(command);
      const diagnosticsByFile = extractDiagnosticsByFile(result.stdout, command.cwd);

      if (result.code === -1 || (result.code !== 0 && diagnosticsByFile === null)) {
        const message = `[startup-analysis] PHPStan crashed in ${command.cwd}. Exit code: ${String(result.code)}.`;
        logger(`${message}\n${result.stderr}`);
        notifyError(`${message} Server will continue with incremental analysis.`);
        return;
      }

      if (!diagnosticsByFile) {
        return;
      }
      for (const [filePath, diagnostics] of diagnosticsByFile.entries()) {
        publishDiagnostics(filePathToUri(filePath), diagnostics);
      }
    } finally {
      workspaceScansInFlight.delete(workspacePath);
    }
  }

  async function runForDocument(document: TextDocument): Promise<void> {
    const currentVersion = versions.get(document.uri);
    if (currentVersion !== document.version) {
      return;
    }

    const filePath = uriToFilePath(document.uri);
    if (!filePath) {
      publishDiagnostics(document.uri, []);
      return;
    }

    const resolvedRuntime = await resolvePhpstanRuntime(filePath);
    const { command, tempFilePath } = await buildAnalyzeCommandForDocument(
      resolvedRuntime,
      filePath,
      document.getText(),
      versionSupportCache,
    );

    try {
      const result = await runProcess(command);
      const staleVersion = versions.get(document.uri);
      if (staleVersion !== document.version) {
        return;
      }

      if (result.code === -1) {
        logger(`[diagnostics] spawn failed: ${result.stderr}`);
        publishDiagnostics(document.uri, []);
        return;
      }

      const diagnostics = extractDiagnosticsForFile(result.stdout, filePath, command.cwd);
      publishDiagnostics(document.uri, diagnostics);
    } finally {
      await cleanupTempPhpFile(tempFilePath);
    }
  }

  return {
    analyzeWorkspace(workspacePath: string): void {
      void runWorkspaceAnalysis(workspacePath);
    },
    schedule(document: TextDocument): void {
      versions.set(document.uri, document.version);
      const existing = timers.get(document.uri);
      if (existing) {
        clearTimeout(existing);
      }
      timers.set(
        document.uri,
        setTimeout(() => {
          timers.delete(document.uri);
          void runForDocument(document);
        }, debounceMs),
      );
    },
    clear(uri: string): void {
      const timer = timers.get(uri);
      if (timer) {
        clearTimeout(timer);
      }
      timers.delete(uri);
      versions.delete(uri);
      publishDiagnostics(uri, []);
    },
    dispose(): void {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      versions.clear();
      versionSupportCache.clear();
    },
  };
}

export const _internal = {
  extractDiagnosticsForFile,
  extractDiagnosticsByFile,
};
