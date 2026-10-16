/** The worker tests' own database next to TEST_DATABASE_URL; undefined when that is unset. */
export function workerDatabaseUrl(): string | undefined {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return undefined;
  const url = new URL(base);
  url.pathname = `${url.pathname}_worker`;
  return url.toString();
}
