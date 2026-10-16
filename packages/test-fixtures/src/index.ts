import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the static fixture pages. */
export const PAGES_DIR = fileURLToPath(new URL("../pages/", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export interface FixtureServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Serves the fixture pages on 127.0.0.1. Port 0 (default) picks a free port. */
export async function startFixtureServer(port = 0): Promise<FixtureServer> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // `/redirect?to=<url>`: a redirect the runner's network rules must still apply to.
    if (url.pathname === "/redirect" && url.searchParams.has("to")) {
      res.writeHead(302, { location: url.searchParams.get("to")! }).end();
      return;
    }
    // `/api/status?code=<n>&delay=<ms>`: answers with that status, for `assertResponse`.
    if (url.pathname === "/api/status") {
      const code = Number(url.searchParams.get("code") ?? 200);
      const delay = Math.min(Number(url.searchParams.get("delay") ?? 0) || 0, 10_000);
      setTimeout(() => {
        res.writeHead(code >= 200 && code <= 599 ? code : 400, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ method: req.method }));
      }, delay);
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    const file = join(PAGES_DIR, pathname === "/" ? "index.html" : pathname);
    const type = CONTENT_TYPES[extname(file)];
    try {
      if (!type || !file.startsWith(PAGES_DIR)) throw new Error("not servable");
      const body = await readFile(file);
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject).listen(port, "127.0.0.1", resolve);
  });
  const actualPort = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
