import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type {
  ReflectionCapability,
  ReflectionRequest,
  ReflectionResponse,
  ReflectionSuccessResult,
} from './protocol.js';
import { REFLECTION_PROTOCOL_VERSION } from './protocol.js';

type Logger = (message: string) => void;

export type ReflectionClient = {
  ping(): Promise<boolean>;
  resolveNodeContext(params: {
    filePath: string;
    cursorOffset: number;
    text?: string;
    capabilities: ReflectionCapability[];
    rangeStartOffset?: number;
    rangeEndOffset?: number;
    newName?: string;
  }): Promise<ReflectionSuccessResult | null>;
  dispose(): void;
};

function createRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createDisabledReflectionClient(logger: Logger = () => undefined): ReflectionClient {
  return {
    async ping(): Promise<boolean> {
      logger('[reflection] disabled: ping skipped');
      return false;
    },
    async resolveNodeContext(params): Promise<ReflectionSuccessResult | null> {
      logger(
        `[reflection] disabled: skipped resolveNodeContext for ${params.filePath} capabilities=${params.capabilities.join(',')}`,
      );
      return null;
    },
    dispose(): void {},
  };
}

export function buildResolveNodeContextRequest(params: {
  filePath: string;
  cursorOffset: number;
  text?: string;
  capabilities: ReflectionCapability[];
  rangeStartOffset?: number;
  rangeEndOffset?: number;
  newName?: string;
}): ReflectionRequest {
  return {
    protocolVersion: REFLECTION_PROTOCOL_VERSION,
    id: createRequestId(),
    method: 'resolveNodeContext',
    params,
  };
}

export function parseReflectionResponse(raw: string): ReflectionResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const candidate = parsed as Partial<ReflectionResponse>;
  if (candidate.protocolVersion !== REFLECTION_PROTOCOL_VERSION) {
    return null;
  }
  if (typeof candidate.id !== 'string' || typeof candidate.ok !== 'boolean') {
    return null;
  }
  return candidate as ReflectionResponse;
}

type PendingRequest = {
  resolve: (response: ReflectionResponse | null) => void;
  timer: NodeJS.Timeout;
};

export function buildPingRequest(): ReflectionRequest {
  return {
    protocolVersion: REFLECTION_PROTOCOL_VERSION,
    id: createRequestId(),
    method: 'ping',
  };
}

export function createPhpProcessReflectionClient(params: {
  workerScriptPath: string;
  phpCommand?: string;
  requestTimeoutMs?: number;
  logger?: Logger;
  loggerInfo?: Logger;
}): ReflectionClient {
  const {
    workerScriptPath,
    phpCommand = 'php',
    requestTimeoutMs = 10000,
    logger = () => undefined,
    loggerInfo = () => undefined,
  } = params;
  let child: ReturnType<typeof spawn> | null = null;
  const pending = new Map<string, PendingRequest>();
  let lineReader: readline.Interface | null = null;

  function clearPending(reason: string): void {
    for (const [id, request] of pending.entries()) {
      clearTimeout(request.timer);
      request.resolve(null);
      pending.delete(id);
    }
    if (reason.length > 0) {
      logger(`[reflection] ${reason}`);
    }
  }

  function ensureStarted(): boolean {
    if (child) {
      return true;
    }
    const spawned = spawn(phpCommand, [workerScriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = spawned;

    lineReader = readline.createInterface({
      input: spawned.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    lineReader.on('line', (line) => {
      const response = parseReflectionResponse(line);
      if (!response) {
        if (line.trim().length > 0) {
          logger(`[reflection] ignored malformed response: ${line}`);
        }
        return;
      }
      const req = pending.get(response.id);
      if (!req) {
        return;
      }
      clearTimeout(req.timer);
      pending.delete(response.id);
      req.resolve(response);
    });

    spawned.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text.length > 0) {
        logger(`[reflection] worker stderr: ${text}`);
      }
    });

    spawned.on('error', (error) => {
      clearPending(`worker failed to start: ${String(error)}`);
      child = null;
      lineReader?.close();
      lineReader = null;
    });

    spawned.on('close', (code) => {
      clearPending(`worker exited with code ${String(code)}`);
      child = null;
      lineReader?.close();
      lineReader = null;
    });

    loggerInfo(`[reflection] worker started: ${phpCommand} ${workerScriptPath}`);
    return true;
  }

  function sendRequest(request: ReflectionRequest): Promise<ReflectionResponse | null> {
    if (!ensureStarted()) {
      return Promise.resolve(null);
    }
    const processRef = child;
    if (!processRef?.stdin) {
      return Promise.resolve(null);
    }
    const stdin = processRef.stdin;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(request.id);
        logger(`[reflection] request timed out: ${request.method} id=${request.id}`);
        resolve(null);
      }, requestTimeoutMs);
      pending.set(request.id, { resolve, timer });
      const payload = JSON.stringify(request);
      stdin.write(`${payload}\n`);
    });
  }

  return {
    async ping(): Promise<boolean> {
      const response = await sendRequest(buildPingRequest());
      return response?.ok === true;
    },
    async resolveNodeContext(params): Promise<ReflectionSuccessResult | null> {
      const response = await sendRequest(buildResolveNodeContextRequest(params));
      if (!response) {
        return null;
      }
      if (!response.ok) {
        logger(
          `[reflection] resolveNodeContext failed: ${response.error?.code ?? 'unknown'} ${response.error?.message ?? ''}`,
        );
        return null;
      }
      return response.result ?? null;
    },
    dispose(): void {
      clearPending('disposing reflection client');
      if (lineReader) {
        lineReader.close();
        lineReader = null;
      }
      if (child) {
        child.kill();
        child = null;
      }
    },
  };
}
