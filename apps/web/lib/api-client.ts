// Browser-side caller for our JSON API (`{ error: { code, message } }` on failure, see lib/api.ts).

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: { code: string; message: string };
}

/** Calls our JSON API; never throws for HTTP or network errors (network → status 0, code "network"). */
export async function api<T = unknown>(path: string, method = "GET", body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok && text === "" && (res.status === 204 || res.status === 205)) return { ok: true, status: res.status };
    let json: { error?: { code: string; message: string } } | undefined;
    try {
      json = JSON.parse(text);
    } catch {
      // A proxy error page or a truncated body: never hand callers `ok` with no data.
      const message = `The server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""} without a readable JSON body`;
      return { ok: false, status: res.status, error: { code: "bad_response", message } };
    }
    if (res.ok) return { ok: true, status: res.status, data: json as T };
    return { ok: false, status: res.status, error: json?.error ?? { code: "internal", message: res.statusText } };
  } catch (err) {
    return { ok: false, status: 0, error: { code: "network", message: err instanceof Error ? err.message : String(err) } };
  }
}
