/**
 * Contrato nativo OpenCode v2 (Spec T04) declarado como literal de test,
 * deliberadamente independiente del adapter: el overlay de permisos dejó de
 * vivir en `stack/config/defaults.json` (canon compartido con Pi, intacto), así
 * que recalcularlo desde el producto no probaría el contrato aprobado.
 *
 * T04: permitir `external_directory`; negar read/edit de los 10 patrones de
 * secretos; permitir `*.env.example` *después* de los denies (el orden decide la
 * precedencia). Sin asks de fricción ni denies de destrucción/Git en el overlay
 * global: esas restricciones viven por rol en `AGENTS.md` (T03/T04).
 */
export const OPENCODE_SECRET_DENY_PATTERNS = [
  "*.env",
  "*.env.*",
  "*.ssh/*",
  "*.aws/credentials",
  "*.npmrc",
  "*.git-credentials",
  "*id_rsa*",
  "*id_ed25519*",
  "*.pem",
  "*.key",
] as const;

export interface NativePermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny";
}

export const NATIVE_OPENCODE_PERMISSIONS: readonly NativePermissionRule[] = [
  { action: "external_directory", resource: "*", effect: "allow" },
  ...(["read", "edit"] as const).flatMap((action) => [
    ...OPENCODE_SECRET_DENY_PATTERNS.map((resource) => ({ action, resource, effect: "deny" as const })),
    { action, resource: "*.env.example", effect: "allow" as const },
  ]),
];
