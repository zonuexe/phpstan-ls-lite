import { promises as fs } from 'node:fs';
import path from 'node:path';

export type PhpstanRuntimeSource =
  | 'scripts.phpstan'
  | 'config.vendor-dir'
  | 'default-vendor-dir'
  | 'bamarni-composer-bin-plugin';

export type PhpstanRuntime =
  | {
      kind: 'command';
      command: string;
      args: string[];
      source: PhpstanRuntimeSource;
    }
  | {
      kind: 'file';
      executablePath: string;
      args: string[];
      source: PhpstanRuntimeSource;
    };

type ComposerJson = {
  scripts?: Record<string, unknown>;
  config?: {
    'vendor-dir'?: unknown;
    'allow-plugins'?: Record<string, unknown>;
  };
  extra?: {
    'bamarni-bin'?: {
      'target-directory'?: unknown;
    };
  };
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function isPathLike(token: string): boolean {
  return token.includes('/') || token.includes('\\') || token.startsWith('.') || path.isAbsolute(token);
}

function normalizeArgs(args: string[]): string[] {
  return args.filter((arg) => arg.length > 0);
}

function splitScriptSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||\||;)/g)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (char === '\'' && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function looksLikePhpstanToken(token: string): boolean {
  const baseName = path.basename(token).toLowerCase();
  return baseName === 'phpstan' || baseName === 'phpstan.phar' || baseName.startsWith('phpstan-');
}

async function detectFromScriptsPhpstan(
  composerDir: string,
  scriptValue: unknown,
): Promise<PhpstanRuntime | null> {
  const commands: string[] = [];
  if (typeof scriptValue === 'string') {
    commands.push(scriptValue);
  } else if (Array.isArray(scriptValue)) {
    for (const entry of scriptValue) {
      if (typeof entry === 'string') {
        commands.push(entry);
      }
    }
  }

  for (const rawCommand of commands) {
    for (const segment of splitScriptSegments(rawCommand)) {
      const tokens = tokenizeCommand(segment);
      for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (!token || !looksLikePhpstanToken(token)) {
          continue;
        }
        const args = normalizeArgs(tokens.slice(i + 1));
        if (isPathLike(token)) {
          const resolvedPath = path.isAbsolute(token) ? token : path.resolve(composerDir, token);
          if (await fileExists(resolvedPath)) {
            return {
              kind: 'file',
              executablePath: resolvedPath,
              args,
              source: 'scripts.phpstan',
            };
          }
          continue;
        }
        return {
          kind: 'command',
          command: token,
          args,
          source: 'scripts.phpstan',
        };
      }
    }
  }
  return null;
}

async function detectFromVendorDir(composerDir: string, vendorDirRaw: unknown): Promise<PhpstanRuntime | null> {
  if (typeof vendorDirRaw !== 'string' || vendorDirRaw.length === 0) {
    return null;
  }
  const vendorDir = path.isAbsolute(vendorDirRaw)
    ? vendorDirRaw
    : path.resolve(composerDir, vendorDirRaw);
  const phpstanPath = path.join(vendorDir, 'bin', 'phpstan');
  if (!(await fileExists(phpstanPath))) {
    return null;
  }
  return {
    kind: 'file',
    executablePath: phpstanPath,
    args: [],
    source: 'config.vendor-dir',
  };
}

async function detectFromDefaultVendorDir(composerDir: string): Promise<PhpstanRuntime | null> {
  const phpstanPath = path.join(composerDir, 'vendor', 'bin', 'phpstan');
  if (!(await fileExists(phpstanPath))) {
    return null;
  }
  return {
    kind: 'file',
    executablePath: phpstanPath,
    args: [],
    source: 'default-vendor-dir',
  };
}

async function detectFromBamarniPlugin(
  composerDir: string,
  composerJson: ComposerJson,
): Promise<PhpstanRuntime | null> {
  const allowPlugins = composerJson.config?.['allow-plugins'];
  const pluginEnabled = allowPlugins?.['bamarni/composer-bin-plugin'] === true;
  if (!pluginEnabled) {
    return null;
  }

  const targetDirectoryRaw = composerJson.extra?.['bamarni-bin']?.['target-directory'];
  const targetDirectory = typeof targetDirectoryRaw === 'string' && targetDirectoryRaw.length > 0
    ? targetDirectoryRaw
    : 'vendor-bin';
  const toolRoot = path.isAbsolute(targetDirectory)
    ? targetDirectory
    : path.resolve(composerDir, targetDirectory);

  const phpstanProjectDir = path.join(toolRoot, 'phpstan');
  try {
    const stat = await fs.stat(phpstanProjectDir);
    if (!stat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  const phpstanPath = path.join(phpstanProjectDir, 'vendor', 'bin', 'phpstan');
  if (!(await fileExists(phpstanPath))) {
    return null;
  }
  return {
    kind: 'file',
    executablePath: phpstanPath,
    args: [],
    source: 'bamarni-composer-bin-plugin',
  };
}

export async function detectPhpstanRuntimeFromComposerJsonPath(
  composerJsonPath: string,
): Promise<PhpstanRuntime | null> {
  let parsed: unknown;
  try {
    const content = await fs.readFile(composerJsonPath, 'utf8');
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const composerJson = parsed as ComposerJson;
  const composerDir = path.dirname(composerJsonPath);

  const scriptCandidate = await detectFromScriptsPhpstan(composerDir, composerJson.scripts?.phpstan);
  if (scriptCandidate) {
    return scriptCandidate;
  }

  const vendorDirCandidate = await detectFromVendorDir(composerDir, composerJson.config?.['vendor-dir']);
  if (vendorDirCandidate) {
    return vendorDirCandidate;
  }

  if (typeof composerJson.config?.['vendor-dir'] !== 'string') {
    const defaultVendorCandidate = await detectFromDefaultVendorDir(composerDir);
    if (defaultVendorCandidate) {
      return defaultVendorCandidate;
    }
  }

  return detectFromBamarniPlugin(composerDir, composerJson);
}

