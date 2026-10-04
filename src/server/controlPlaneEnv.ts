/** Server credentials and authority configuration never belong to model children. */
export const CONTROL_PLANE_ENV = ["EBI_AUTH_TOKEN", "NEGI_REVIEW_CONFIG", "NEGI_TASK_CONFIG", "NEGI_KNOWLEDGE_CONFIG", "NEGI_POLICY_CONFIG", "NEGI_POLICY_SIGNING_SECRET", "NEGI_INTEGRATION_CONFIG", "NEGI_TASK_AUTHORING_CONFIG", "NEGI_SETUP_ROOT"] as const;
export function withoutControlPlaneEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const denied = new Set<string>(CONTROL_PLANE_ENV);
  return Object.fromEntries(Object.entries(env).filter(([key]) => !denied.has(key.toUpperCase())));
}
