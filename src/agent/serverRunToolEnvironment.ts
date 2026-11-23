/** Add concrete recovery steps only for execution-environment failures. */
export function environmentFailureHint(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error);
  if (!/unavailable|not connected|app-server|cannot call|no editor|bridge|environment|execution/i.test(base)) {
    return base;
  }
  return `${base} If this is an execution-environment failure, verify the project is open, Codex is signed in (Settings → Codex), and the app service is running.`;
}
