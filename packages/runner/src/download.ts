// `uploadFile` downloads (spec 3.1): the runner fetches each URL itself, so the same block rules as the
// browser apply to the URL, every redirect hop and the addresses the host name resolves to.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { StepFailure } from "./actions.js";
import { isBlockedUrl, type NetworkRules } from "./network.js";

export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const EXTENSION_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

export interface DownloadedFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

async function checkAllowed(url: URL, network: NetworkRules): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new StepFailure("download_failed", `could not download file (not http/https): ${url.href}`);
  if (isBlockedUrl(url.href, network)) throw new StepFailure("blocked_request", `Blocked request to ${url.href}`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return;
  const addresses = await lookup(host, { all: true }).catch(() => []);
  for (const { address, family } of addresses) {
    const literal = family === 6 ? `http://[${address}]/` : `http://${address}/`;
    if (isBlockedUrl(literal, network)) throw new StepFailure("blocked_request", `Blocked request to ${url.href} (${address})`);
  }
}

export async function downloadFile(raw: string, opts: { network: NetworkRules; timeoutMs: number; signal: AbortSignal; maxBytes?: number }): Promise<DownloadedFile> {
  const maxBytes = opts.maxBytes ?? UPLOAD_MAX_BYTES;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StepFailure("download_failed", `could not download file (invalid URL): ${raw}`);
  }
  const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]);
  let response: Response | undefined;
  for (let hop = 0; ; hop++) {
    await checkAllowed(url, opts.network);
    response = await fetch(url, { redirect: "manual", signal }).catch((err: Error) => {
      throw new StepFailure("download_failed", `could not download file (${err.name === "TimeoutError" ? "timeout" : err.message}): ${raw}`);
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) throw new StepFailure("download_failed", `could not download file (too many redirects): ${raw}`);
      url = new URL(location, url);
      continue;
    }
    break;
  }
  if (response.status < 200 || response.status >= 300) throw new StepFailure("download_failed", `could not download file (HTTP ${response.status}): ${raw}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new StepFailure("download_failed", `could not download file (larger than ${maxBytes} bytes): ${raw}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > maxBytes) throw new StepFailure("download_failed", `could not download file (larger than ${maxBytes} bytes): ${raw}`);
    chunks.push(chunk);
  }
  const last = new URL(raw).pathname.split("/").at(-1) ?? "";
  let name = "";
  try {
    name = decodeURIComponent(last);
  } catch {
    name = last;
  }
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  let mimeType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!mimeType || mimeType === "application/octet-stream") mimeType = (ext && EXTENSION_TYPES[ext]) || "application/octet-stream";
  if (!name) {
    const fromType = Object.entries(EXTENSION_TYPES).find(([, t]) => t === mimeType)?.[0];
    name = fromType ? `upload.${fromType}` : "upload";
  }
  return { name, mimeType, buffer: Buffer.concat(chunks) };
}
