import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
  errors?: unknown;
};

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

type PublishDiagnostics = (uri: string, diagnostics: Diagnostic[]) => void;
type LogMessage = (message: string) => void;

type ScheduleTrigger = 'open' | 'change' | 'save';

type CommandOverride = {
  command: string;
  args?: string[];
} | null;

export type PhpstanDiagnosticsSettings = {
  enableDiagnostics: boolean;
  runOnDidSaveOnly: boolean;
  phpstan: {
    extraArgs: string[];
    commandOverride: CommandOverride;
  };
};

export type PhpstanDiagnosticsSettingsUpdate = {
  enableDiagnostics?: boolean;
  runOnDidSaveOnly?: boolean;
  phpstan?: {
    extraArgs?: string[];
    commandOverride?: CommandOverride;
  };
};

export type PhpstanDiagnosticsService = {
  updateSettings(settings: PhpstanDiagnosticsSettingsUpdate): void;
  schedule(document: TextDocument, trigger: ScheduleTrigger): void;
  clear(uri: string): void;
  dispose(): void;
};

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_SETTINGS: PhpstanDiagnosticsSettings = {
  enableDiagnostics: true,
  runOnDidSaveOnly: false,
  phpstan: {
    extraArgs: [],
    commandOverride: null,
  },
};

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

function runProcess(
  commandSpec: PhpstanAnalyzeCommand | { command: string; args: string[]; cwd: string },
): Promise<CommandResult> {
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

function runtimeSourceLabel(resolvedRuntime: ResolvedPhpstanRuntime): string {
  if (resolvedRuntime.kind === 'fallback') {
    return 'fallback';
  }
  return resolvedRuntime.runtime.source;
}

function maskArgumentToken(token: string): string {
  const sensitiveKeys = ['token', 'password', 'secret', 'apikey', 'api-key'];
  const eqIndex = token.indexOf('=');
  if (eqIndex < 0) {
    return token;
  }
  const key = token.slice(0, eqIndex).toLowerCase();
  if (sensitiveKeys.some((sensitive) => key.includes(sensitive))) {
    return `${token.slice(0, eqIndex + 1)}***`;
  }
  return token;
}

function maskCommandArgs(args: readonly string[]): string[] {
  const sensitiveFlags = new Set(['--token', '--password', '--secret', '--api-key', '--apikey']);
  const masked: string[] = [];
  let maskNext = false;
  for (const arg of args) {
    if (maskNext) {
      masked.push('***');
      maskNext = false;
      continue;
    }
    const lowered = arg.toLowerCase();
    if (sensitiveFlags.has(lowered)) {
      masked.push(arg);
      maskNext = true;
      continue;
    }
    masked.push(maskArgumentToken(arg));
  }
  return masked;
}

function formatCommandForLog(command: string, args: readonly string[]): string {
  return [command, ...maskCommandArgs(args)].join(' ');
}

function mergeSettings(
  base: PhpstanDiagnosticsSettings,
  incoming: PhpstanDiagnosticsSettingsUpdate,
): PhpstanDiagnosticsSettings {
  const extraArgs = incoming.phpstan?.extraArgs;
  return {
    enableDiagnostics: incoming.enableDiagnostics ?? base.enableDiagnostics,
    runOnDidSaveOnly: incoming.runOnDidSaveOnly ?? base.runOnDidSaveOnly,
    phpstan: {
      extraArgs: Array.isArray(extraArgs) ? extraArgs : base.phpstan.extraArgs,
      commandOverride:
        incoming.phpstan?.commandOverride === undefined
          ? base.phpstan.commandOverride
          : incoming.phpstan.commandOverride,
    },
  };
}

function injectArgsBeforeTargetSeparator(
  originalArgs: readonly string[],
  injectedArgs: readonly string[],
): string[] {
  if (injectedArgs.length === 0) {
    return [...originalArgs];
  }
  const separatorIndex = originalArgs.indexOf('--');
  if (separatorIndex < 0) {
    return [...originalArgs, ...injectedArgs];
  }
  return [
    ...originalArgs.slice(0, separatorIndex),
    ...injectedArgs,
    ...originalArgs.slice(separatorIndex),
  ];
}

function applyCommandOverride(
  commandSpec: { command: string; args: string[]; cwd: string },
  commandOverride: CommandOverride,
): { command: string; args: string[]; cwd: string } {
  if (!commandOverride) {
    return commandSpec;
  }
  return {
    command: commandOverride.command,
    args: [...(commandOverride.args ?? []), ...commandSpec.args],
    cwd: commandSpec.cwd,
  };
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

function createExecutionFailureDiagnostic(code: number | null, stderr: string): Diagnostic {
  const firstLine = stderr
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const details = firstLine ?? 'Unknown PHPStan execution error.';
  return {
    severity: 1 as DiagnosticSeverity,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    },
    source: 'phpstan-ls-lite',
    message: `PHPStan execution failed (exit code: ${String(code)}): ${details}`,
  };
}

function createGlobalErrorDiagnostic(message: string): Diagnostic {
  return {
    severity: 1 as DiagnosticSeverity,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    },
    source: 'phpstan',
    message,
  };
}

function hasPhpSyntaxError(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  return text.includes('parse error') || text.includes('syntax error');
}

function extractGlobalErrors(outputText: string): Diagnostic[] {
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
  if (!Array.isArray(output.errors)) {
    return [];
  }
  const diagnostics: Diagnostic[] = [];
  for (const error of output.errors) {
    if (typeof error === 'string' && error.trim().length > 0) {
      diagnostics.push(createGlobalErrorDiagnostic(error.trim()));
    }
  }
  return diagnostics;
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
  settings: PhpstanDiagnosticsSettings,
  versionSupportCache: Map<string, boolean>,
): Promise<boolean> {
  const versionCommand = applyCommandOverride(
    getPhpstanVersionCommand(resolvedRuntime),
    settings.phpstan.commandOverride,
  );
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
  settings: PhpstanDiagnosticsSettings,
  filePath: string,
  content: string,
  versionSupportCache: Map<string, boolean>,
): Promise<{
  command: PhpstanAnalyzeCommand;
  tempFilePath: string;
  editorModeUsed: boolean;
}> {
  const tempFilePath = await createTempPhpFile(content);
  const baseCommand = buildPhpstanAnalyzeCommand({
    resolvedRuntime,
    targets: [filePath],
    errorFormat: 'json',
  });
  const editorModeSupported = await detectEditorMode(
    resolvedRuntime,
    settings,
    versionSupportCache,
  );
  const extraArgsCommand = {
    command: baseCommand.command,
    cwd: baseCommand.cwd,
    args: injectArgsBeforeTargetSeparator(baseCommand.args, settings.phpstan.extraArgs),
  };
  const command = applyCommandOverride(extraArgsCommand, settings.phpstan.commandOverride);
  if (editorModeSupported) {
    return {
      command: applyEditorModeArgs(command, tempFilePath, filePath),
      tempFilePath,
      editorModeUsed: true,
    };
  }
  return {
    command: applyTempFileFallbackArgs(command, tempFilePath),
    tempFilePath,
    editorModeUsed: false,
  };
}

function buildAnalyzeCommandForSavedFile(
  resolvedRuntime: ResolvedPhpstanRuntime,
  settings: PhpstanDiagnosticsSettings,
  filePath: string,
): PhpstanAnalyzeCommand {
  const baseCommand = buildPhpstanAnalyzeCommand({
    resolvedRuntime,
    targets: [filePath],
    errorFormat: 'json',
  });
  const extraArgsCommand = {
    command: baseCommand.command,
    cwd: baseCommand.cwd,
    args: injectArgsBeforeTargetSeparator(baseCommand.args, settings.phpstan.extraArgs),
  };
  return applyCommandOverride(extraArgsCommand, settings.phpstan.commandOverride);
}

export function createPhpstanDiagnosticsService(params: {
  publishDiagnostics: PublishDiagnostics;
  logger?: LogMessage;
  loggerInfo?: LogMessage;
  debounceMs?: number;
}): PhpstanDiagnosticsService {
  const {
    publishDiagnostics,
    logger = () => undefined,
    loggerInfo = () => undefined,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  } = params;
  const timers = new Map<string, NodeJS.Timeout>();
  const versions = new Map<string, number>();
  const versionSupportCache = new Map<string, boolean>();
  const pendingDocuments = new Map<string, TextDocument>();
  let documentAnalysisChain: Promise<void> = Promise.resolve();
  let settings = DEFAULT_SETTINGS;

  function enqueueDocumentTask(task: () => Promise<void>): void {
    documentAnalysisChain = documentAnalysisChain.then(task).catch((error) => {
      logger(`[diagnostics] task failed: ${String(error)}`);
    });
  }

  function compact(text: string, maxLength = 400): string {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    if (oneLine.length <= maxLength) {
      return oneLine;
    }
    return `${oneLine.slice(0, maxLength)}...`;
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
    const { command, tempFilePath, editorModeUsed } = await buildAnalyzeCommandForDocument(
      resolvedRuntime,
      settings,
      filePath,
      document.getText(),
      versionSupportCache,
    );
    const runtimeSource = runtimeSourceLabel(resolvedRuntime);
    const commandText = formatCommandForLog(command.command, command.args);

    try {
      const result = await runProcess(command);
      const staleVersion = versions.get(document.uri);
      if (staleVersion !== document.version) {
        return;
      }

      if (result.code === -1) {
        logger(
          `[diagnostics] spawn failed for ${filePath}. source=${runtimeSource} command="${commandText}"\n${result.stderr}`,
        );
        publishDiagnostics(document.uri, [
          createExecutionFailureDiagnostic(result.code, result.stderr),
        ]);
        return;
      }
      if (result.code !== 0 && result.stderr.trim().length > 0) {
        loggerInfo(
          `[diagnostics] PHPStan exited with code ${String(result.code)} for ${filePath}. source=${runtimeSource} command="${commandText}" ${compact(result.stderr)}`,
        );
      }

      let diagnostics = extractDiagnosticsForFile(result.stdout, filePath, command.cwd);
      if (!editorModeUsed && diagnostics.length === 0) {
        diagnostics = extractDiagnosticsForFile(result.stdout, tempFilePath, command.cwd);
      }
      if (diagnostics.length === 0) {
        diagnostics = extractGlobalErrors(result.stdout);
      }
      if (diagnostics.length === 0 && result.code !== 0 && result.stderr.trim().length > 0) {
        if (hasPhpSyntaxError(result.stdout, result.stderr)) {
          const fallbackCommand = buildAnalyzeCommandForSavedFile(
            resolvedRuntime,
            settings,
            filePath,
          );
          loggerInfo(
            `[diagnostics] syntax error detected in unsaved buffer; falling back to saved file analysis for ${filePath}. command="${formatCommandForLog(fallbackCommand.command, fallbackCommand.args)}"`,
          );
          const fallbackResult = await runProcess(fallbackCommand);
          const fallbackStaleVersion = versions.get(document.uri);
          if (fallbackStaleVersion !== document.version) {
            return;
          }
          diagnostics = extractDiagnosticsForFile(
            fallbackResult.stdout,
            filePath,
            fallbackCommand.cwd,
          );
          if (diagnostics.length === 0) {
            diagnostics = extractGlobalErrors(fallbackResult.stdout);
          }
          if (
            diagnostics.length === 0 &&
            fallbackResult.code !== 0 &&
            fallbackResult.stderr.trim().length > 0
          ) {
            diagnostics = [
              createExecutionFailureDiagnostic(fallbackResult.code, fallbackResult.stderr),
            ];
          }
        } else {
          diagnostics = [createExecutionFailureDiagnostic(result.code, result.stderr)];
        }
      }
      publishDiagnostics(document.uri, diagnostics);
    } finally {
      await cleanupTempPhpFile(tempFilePath);
    }
  }

  return {
    updateSettings(incoming: PhpstanDiagnosticsSettingsUpdate): void {
      settings = mergeSettings(settings, incoming);
      if (settings.enableDiagnostics) {
        return;
      }
      for (const uri of versions.keys()) {
        publishDiagnostics(uri, []);
      }
    },
    schedule(document: TextDocument, trigger: ScheduleTrigger): void {
      if (!settings.enableDiagnostics) {
        return;
      }
      if (settings.runOnDidSaveOnly && trigger !== 'save') {
        return;
      }
      versions.set(document.uri, document.version);
      const existing = timers.get(document.uri);
      if (existing) {
        clearTimeout(existing);
      }
      timers.set(
        document.uri,
        setTimeout(() => {
          timers.delete(document.uri);
          pendingDocuments.set(document.uri, document);
          enqueueDocumentTask(async () => {
            const pending = pendingDocuments.get(document.uri);
            if (!pending) {
              return;
            }
            pendingDocuments.delete(document.uri);
            await runForDocument(pending);
          });
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
      pendingDocuments.delete(uri);
      publishDiagnostics(uri, []);
    },
    dispose(): void {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      versions.clear();
      versionSupportCache.clear();
      pendingDocuments.clear();
    },
  };
}

export const _internal = {
  createExecutionFailureDiagnostic,
  hasPhpSyntaxError,
  extractGlobalErrors,
  extractDiagnosticsForFile,
  extractDiagnosticsByFile,
  formatCommandForLog,
};
