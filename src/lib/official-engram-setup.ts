import type { RuntimeId } from "../adapters/types.js";

export interface OfficialSetupVerifyResult {
  ok: boolean;
  layers?: string[];
  duplicates?: boolean;
  reason?: string;
}
export type OfficialSetupVerifyFn = (args: {
  configDir: string;
  engramBin: string;
  homeDir?: string;
  isExplicitClaudeConfigDir?: boolean;
}) => Promise<OfficialSetupVerifyResult>;

export const officialSetupVerifiers: Partial<Record<RuntimeId, OfficialSetupVerifyFn>> = {};
export function registerOfficialSetupVerifier(runtime: RuntimeId, fn: OfficialSetupVerifyFn): void {
  officialSetupVerifiers[runtime] = fn;
}
