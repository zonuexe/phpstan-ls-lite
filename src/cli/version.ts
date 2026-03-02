import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

type PackageJson = {
  version?: unknown;
};

let cachedVersion: string | null = null;

export async function getServerVersion(): Promise<string> {
  if (cachedVersion) {
    return cachedVersion;
  }
  const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));
  try {
    const raw = await readFile(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as PackageJson;
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      cachedVersion = parsed.version;
      return parsed.version;
    }
  } catch {
    // Ignore and fallback below.
  }
  cachedVersion = 'unknown';
  return cachedVersion;
}

export function formatVersionText(version: string): string {
  return `phpstan-ls-lite ${version}`;
}
