// Write endpoints the run screens call that the worker team builds (stage 3 contract section 10). Until a route
// exists on this branch its button shows a "coming" state instead of failing. run-endpoints.test.ts compares
// these flags with the route files, so a merge that adds a route fails the test until its flag is flipped.
export const WRITE_ENDPOINTS = {
  /** POST { environmentId, steps, options? } → 201 RunDetail */
  testRun: { route: "runs/test", method: "POST", available: true },
  /** POST → 201 { id, runIds } (new group); 409 when nothing failed */
  rerunFailed: { route: "groups/[groupId]/rerun-failed", method: "POST", available: true },
  /** POST → 200 { cancelled, cancelRequested } */
  stopAll: { route: "runs/stop-all", method: "POST", available: true },
  /** POST multipart (file, name) → 201 { id, name, version, contentType, sizeBytes }; 413 when too large */
  attachmentUpload: { route: "attachments/upload", method: "POST", available: true },
} as const;

export type WriteEndpoint = keyof typeof WRITE_ENDPOINTS;

export function endpointUrl(slug: string, name: WriteEndpoint, params: Record<string, string> = {}): string {
  const path = WRITE_ENDPOINTS[name].route.replace(/\[(\w+)\]/g, (_, key: string) => encodeURIComponent(params[key] ?? ""));
  return `/api/w/${slug}/${path}`;
}
