import type { PhpstanAnalyzeCommand, ResolvedPhpstanRuntime } from './phpstanCommand.js';

const MIN_SUPPORTED_V1: readonly number[] = [1, 12, 27];
const MIN_SUPPORTED_V2: readonly number[] = [2, 1, 17];

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l < r) {
      return -1;
    }
    if (l > r) {
      return 1;
    }
  }
  return 0;
}

function extractSemver(versionOutput: string): readonly number[] | null {
  const match = versionOutput.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isPhpstanEditorModeSupported(versionOutput: string): boolean {
  if (versionOutput.includes('-dev@')) {
    return true;
  }
  const semver = extractSemver(versionOutput);
  if (!semver) {
    return false;
  }
  const major = semver[0] ?? 0;
  if (major === 1) {
    return compareVersions(semver, MIN_SUPPORTED_V1) >= 0;
  }
  if (major === 2) {
    return compareVersions(semver, MIN_SUPPORTED_V2) >= 0;
  }
  return major > 2;
}

function splitByTargetSeparator(args: readonly string[]): { base: string[]; targets: string[] } {
  const separatorIndex = args.indexOf('--');
  if (separatorIndex < 0) {
    return { base: [...args], targets: [] };
  }
  return {
    base: args.slice(0, separatorIndex),
    targets: args.slice(separatorIndex + 1),
  };
}

export function applyEditorModeArgs(
  baseCommand: PhpstanAnalyzeCommand,
  tempFilePath: string,
  originalFilePath: string,
): PhpstanAnalyzeCommand {
  const { base } = splitByTargetSeparator(baseCommand.args);
  return {
    command: baseCommand.command,
    cwd: baseCommand.cwd,
    args: [
      ...base,
      '--tmp-file',
      tempFilePath,
      '--instead-of',
      originalFilePath,
      '--',
      originalFilePath,
    ],
  };
}

export function applyTempFileFallbackArgs(
  baseCommand: PhpstanAnalyzeCommand,
  tempFilePath: string,
): PhpstanAnalyzeCommand {
  const { base } = splitByTargetSeparator(baseCommand.args);
  return {
    command: baseCommand.command,
    cwd: baseCommand.cwd,
    args: [...base, '--', tempFilePath],
  };
}

export function getPhpstanVersionCommand(resolvedRuntime: ResolvedPhpstanRuntime): {
  command: string;
  args: string[];
  cwd: string;
} {
  const runtime = resolvedRuntime.runtime;
  return {
    command: runtime.kind === 'file' ? runtime.executablePath : runtime.command,
    args: ['--version'],
    cwd: resolvedRuntime.workingDirectory,
  };
}
