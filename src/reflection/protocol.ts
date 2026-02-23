export const REFLECTION_PROTOCOL_VERSION = 1;

export type ReflectionCapability = 'hover' | 'callArguments' | 'definition';

export type ReflectionRequest =
  | {
      protocolVersion: 1;
      id: string;
      method: 'ping';
    }
  | {
      protocolVersion: 1;
      id: string;
      method: 'resolveNodeContext';
      params: {
        filePath: string;
        cursorOffset: number;
        rangeStartOffset?: number;
        rangeEndOffset?: number;
        text?: string;
        capabilities: ReflectionCapability[];
      };
    };

export type ReflectionHoverPayload = {
  markdown: string;
};

export type ReflectionCallArgumentHint = {
  argumentIndex: number;
  argumentStartOffset: number;
  parameterName: string;
  hide: boolean;
};

export type ReflectionCallArgumentPayload = {
  callStartOffset: number;
  hints: ReflectionCallArgumentHint[];
};

export type ReflectionSuccessResult = {
  hover?: ReflectionHoverPayload;
  callArguments?: ReflectionCallArgumentPayload[];
  definitions?: ReflectionDefinitionLocation[];
};

export type ReflectionDefinitionLocation = {
  filePath: string;
  line: number;
  character: number;
};

export type ReflectionErrorResult = {
  code: string;
  message: string;
};

export type ReflectionResponse = {
  protocolVersion: 1;
  id: string;
  ok: boolean;
  result?: ReflectionSuccessResult;
  error?: ReflectionErrorResult;
};
