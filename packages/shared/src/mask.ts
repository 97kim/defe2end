export const SECRET_MASK = "••••••";

/**
 * Replaces every occurrence of each secret value in `text` (logs, error messages,
 * step results). Longer secrets are replaced first so overlapping values are fully hidden.
 */
export function maskSecrets(text: string, secrets: Iterable<string>): string {
  const values = [...new Set(secrets)].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  let masked = text;
  for (const value of values) masked = masked.split(value).join(SECRET_MASK);
  return masked;
}
