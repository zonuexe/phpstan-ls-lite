import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PhpstanRuntime } from './phpstanRuntime.js';
import { detectPhpstanRuntimeFromComposerJsonPath } from './phpstanRuntime.js';

export type ResolvedPhpstanRuntime =
  | {
      kind: 'detected';
      runtime: PhpstanRuntime;
      composerJsonPath: string;
      workingDirectory: string;
    }
  | {
      kind: 'fallback';
      runtime: {
        kind: 'command';
        command: 'phpstan';
        args: [];
        source: 'fallback';
      };
      composerJsonPath: null;
      workingDirectory: string;
    };

export type PhpstanAnalyzeCommand = {
  command: string;
  args: string[];
  cwd: string;
};

type BuildAnalyzeCommandParams = {
  resolvedRuntime: ResolvedPhpstanRuntime;
  targets: string[];
  configPath?: string;
  errorFormat?: string;
  options?: string[];
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeToFsPath(pathOrUri: string): string {
  if (pathOrUri.startsWith('file://')) {
    return fileURLToPath(pathOrUri);
  }
  return path.resolve(pathOrUri);
}

export async function findNearestComposerJson(pathOrUri: string): Promise<string | null> {
  let current = normalizeToFsPath(pathOrUri);
  let statTarget = current;

  if (!(await fileExists(statTarget))) {
    statTarget = path.dirname(statTarget);
  }

  current = statTarget;
  while (true) {
    const candidate = path.join(current, 'composer.json');
    if (await fileExists(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export async function resolvePhpstanRuntime(pathOrUri: string): Promise<ResolvedPhpstanRuntime> {
  const normalizedPath = normalizeToFsPath(pathOrUri);
  const workingDirectory = path.dirname(normalizedPath);
  const composerJsonPath = await findNearestComposerJson(normalizedPath);
  if (!composerJsonPath) {
    return {
      kind: 'fallback',
      runtime: {
        kind: 'command',
        command: 'phpstan',
        args: [],
        source: 'fallback',
      },
      composerJsonPath: null,
      workingDirectory,
    };
  }

  const runtime = await detectPhpstanRuntimeFromComposerJsonPath(composerJsonPath);
  if (!runtime) {
    return {
      kind: 'fallback',
      runtime: {
        kind: 'command',
        command: 'phpstan',
        args: [],
        source: 'fallback',
      },
      composerJsonPath: null,
      workingDirectory: path.dirname(composerJsonPath),
    };
  }

  return {
    kind: 'detected',
    runtime,
    composerJsonPath,
    workingDirectory: path.dirname(composerJsonPath),
  };
}

function normalizeRuntimeArgs(runtimeArgs: string[]): string[] {
  if (runtimeArgs.length === 0) {
    return [];
  }
  const [first, ...rest] = runtimeArgs;
  if (first === 'analyze' || first === 'analyse') {
    return rest;
  }
  return runtimeArgs;
}

export function buildPhpstanAnalyzeCommand(params: BuildAnalyzeCommandParams): PhpstanAnalyzeCommand {
  const { resolvedRuntime, targets, configPath, errorFormat = 'json', options = [] } = params;
  const runtime = resolvedRuntime.runtime;
  const normalizedRuntimeArgs = normalizeRuntimeArgs(runtime.args);
  const command = runtime.kind === 'file' ? runtime.executablePath : runtime.command;

  const args = [
    ...normalizedRuntimeArgs,
    'analyze',
    `--error-format=${errorFormat}`,
    '--no-progress',
    '--no-interaction',
  ];
  if (configPath) {
    args.push('-c', configPath);
  }
  args.push(...options);
  args.push('--', ...targets);

  return {
    command,
    args,
    cwd: resolvedRuntime.workingDirectory,
  };
}

