// The only page the window may show in stage 0 is the bundled local page.
// Anything else (links, redirects, injected script) is refused.
export function isAllowedNavigation(target: string, appPageUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return false;
  }
  const allowed = new URL(appPageUrl);
  return (
    parsed.protocol === allowed.protocol &&
    parsed.host === allowed.host &&
    parsed.pathname === allowed.pathname
  );
}
