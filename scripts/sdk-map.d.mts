export interface OverlayAction {
  target: string;
  operation: string;
  update: Record<string, string | boolean>;
}

export interface OperationClass {
  ignore: boolean;
  group?: string;
  method?: string;
}

export interface SdkMap {
  mapeadas: Record<string, string>;
  fuera: Record<string, string>;
}

export interface OpenApiDoc {
  info?: { version?: string };
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
}

export const SCHEMA_DIR: string;
export const SPEC_FILE: string;
export const OVERLAY_FILE: string;
export const MAP_FILE: string;
export const SOURCE_FILE: string;

export function readSchemaFile(name: string): Buffer;
export function sha256(bytes: Buffer | string): string;
export function parseSource(text: string): { meta: Record<string, string>; files: Record<string, string> };
export function operations(spec: OpenApiDoc): string[];
export function parseOverlay(text: string): OverlayAction[];
export function classify(spec: OpenApiDoc, actions: OverlayAction[]): Map<string, OperationClass>;
export function hiddenOperations(spec: OpenApiDoc, actions: OverlayAction[]): Set<string>;
export function validateMap(spec: OpenApiDoc, actions: OverlayAction[], map: SdkMap): string[];
export function matchOperation(spec: OpenApiDoc, method: string, pathname: string): string | null;
export function watchedSchemas(spec: OpenApiDoc, map: SdkMap): string[];
export function loadContract(): { spec: OpenApiDoc; actions: OverlayAction[]; map: SdkMap };
