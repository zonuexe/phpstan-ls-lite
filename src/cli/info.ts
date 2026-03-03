import path from 'node:path';
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { getPhpstanVersionCommand } from '../runtime/phpstanEditorMode.js';
import { getServerVersion } from './version.js';
import { resolvePhpstanRuntime, type ResolvedPhpstanRuntime } from '../runtime/phpstanCommand.js';

type CommandExecutionResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: Error | null;
};

type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<CommandExecutionResult>;

export type EnvironmentInfo = {
  serverVersion: string;
  serverPath: string;
  cwd: string;
  composerJsonPath: string | null;
  phpVersion: string;
  phpBinaryPath: string;
  phpstanSource: string;
  phpstanWorkingDirectory: string;
  phpstanRuntimeKind: 'file' | 'command';
  phpstanRuntimePath: string;
  phpstanRuntimeArgs: string[];
  phpstanVersion: string;
};

function normalizeOutput(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function pickOutput(result: CommandExecutionResult): string {
  if (result.error) {
    return `(failed: ${result.error.message})`;
  }
  if (result.exitCode !== 0) {
    const detail = normalizeOutput(result.stderr || result.stdout);
    if (detail.length > 0) {
      return `(failed: ${detail})`;
    }
    return `(failed: exit ${String(result.exitCode)})`;
  }
  const text = normalizeOutput(result.stdout || result.stderr);
  if (text.length === 0) {
    return '(empty output)';
  }
  return text;
}

async function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<CommandExecutionResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let error: Error | null = null;

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', (spawnError) => {
      error = spawnError;
    });
    child.once('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr, error });
    });
  });
}

async function resolveCommandPath(
  command: string,
  cwd: string,
  platform: NodeJS.Platform,
  runCommand: CommandRunner,
): Promise<string | null> {
  if (path.isAbsolute(command)) {
    return command;
  }
  if (command.includes('/') || command.includes('\\')) {
    return path.resolve(cwd, command);
  }

  const lookup = platform === 'win32' ? 'where' : 'which';
  const lookupResult = await runCommand(lookup, [command], cwd);
  if (lookupResult.exitCode !== 0) {
    return null;
  }
  const firstLine = lookupResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ?? null;
}

export async function collectEnvironmentInfo(options?: {
  cwd?: string;
  platform?: NodeJS.Platform;
  resolveRuntime?: (pathOrUri: string) => Promise<ResolvedPhpstanRuntime>;
  runCommand?: CommandRunner;
  getVersion?: () => Promise<string>;
  getServerPath?: () => Promise<string>;
}): Promise<EnvironmentInfo> {
  const cwd = options?.cwd ?? process.cwd();
  const platform = options?.platform ?? process.platform;
  const resolveRuntime = options?.resolveRuntime ?? resolvePhpstanRuntime;
  const runCommand = options?.runCommand ?? runProcess;
  const getVersion = options?.getVersion ?? getServerVersion;
  const getServerPath =
    options?.getServerPath ??
    (async () => {
      const arg1 = process.argv[1];
      if (!arg1) {
        return '(unknown)';
      }
      try {
        return await realpath(arg1);
      } catch {
        return path.resolve(arg1);
      }
    });

  const serverVersion = await getVersion();
  const serverPath = await getServerPath();
  const resolvedRuntime = await resolveRuntime(cwd);
  const phpVersionResult = await runCommand('php', ['-r', 'echo PHP_VERSION;'], cwd);
  const phpBinaryResult = await runCommand('php', ['-r', 'echo PHP_BINARY;'], cwd);
  const versionCommand = getPhpstanVersionCommand(resolvedRuntime);
  const phpstanVersionResult = await runCommand(
    versionCommand.command,
    versionCommand.args,
    versionCommand.cwd,
  );

  const runtimePath =
    resolvedRuntime.runtime.kind === 'file'
      ? resolvedRuntime.runtime.executablePath
      : ((await resolveCommandPath(
          resolvedRuntime.runtime.command,
          resolvedRuntime.workingDirectory,
          platform,
          runCommand,
        )) ?? `(not found in PATH: ${resolvedRuntime.runtime.command})`);

  return {
    serverVersion,
    serverPath,
    cwd,
    composerJsonPath: resolvedRuntime.composerJsonPath,
    phpVersion: pickOutput(phpVersionResult),
    phpBinaryPath: pickOutput(phpBinaryResult),
    phpstanSource: resolvedRuntime.runtime.source,
    phpstanWorkingDirectory: resolvedRuntime.workingDirectory,
    phpstanRuntimeKind: resolvedRuntime.runtime.kind,
    phpstanRuntimePath: runtimePath,
    phpstanRuntimeArgs: [...resolvedRuntime.runtime.args],
    phpstanVersion: pickOutput(phpstanVersionResult),
  };
}

export function formatEnvironmentInfo(info: EnvironmentInfo): string {
  const args = info.phpstanRuntimeArgs.length > 0 ? info.phpstanRuntimeArgs.join(' ') : '(none)';
  const composerJsonPath = info.composerJsonPath ?? '(not found)';
  return [
    `server.version: ${info.serverVersion}`,
    `server.path: ${info.serverPath}`,
    `cwd: ${info.cwd}`,
    `composer.json: ${composerJsonPath}`,
    `php.version: ${info.phpVersion}`,
    `php.binary: ${info.phpBinaryPath}`,
    `phpstan.source: ${info.phpstanSource}`,
    `phpstan.cwd: ${info.phpstanWorkingDirectory}`,
    `phpstan.runtime.kind: ${info.phpstanRuntimeKind}`,
    `phpstan.runtime.path: ${info.phpstanRuntimePath}`,
    `phpstan.runtime.args: ${args}`,
    `phpstan.version: ${info.phpstanVersion}`,
  ].join('\n');
}

export async function runInfoCommand(io?: {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}): Promise<number> {
  const writeStdout = io?.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeStderr = io?.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const info = await collectEnvironmentInfo();
    writeStdout(formatEnvironmentInfo(info));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`Failed to collect runtime info: ${message}`);
    return 1;
  }
}
