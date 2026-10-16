import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";

/**
 * A minimal OpenID provider for integration tests: discovery, JWKS and a token endpoint that
 * returns an RS256 id_token for whatever identity the test queues with `nextLogin`.
 */
export interface FakeOidc {
  url: string;
  issuer: string;
  discoveryUrl: string;
  /** Identity for the next code exchange. `iss` defaults to the provider's issuer. */
  nextLogin(claims: { sub: string; email: string; email_verified: boolean; name?: string; iss?: string }): void;
  close(): Promise<void>;
}

export async function startFakeOidc(opts: { clientId: string; issuerOverride?: string }): Promise<FakeOidc> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomUUID();
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  let pending: Parameters<FakeOidc["nextLogin"]>[0] | undefined;
  const nonces = new Map<string, string>();
  let base = "";

  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const idToken = (claims: Record<string, unknown>) => {
    const head = b64({ alg: "RS256", typ: "JWT", kid });
    const body = b64(claims);
    return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer: opts.issuerOverride ?? base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        userinfo_endpoint: `${base}/userinfo`,
        jwks_uri: `${base}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
      });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/next-login" && req.method === "POST") {
      // For browser smoke runs where the provider lives in another process.
      let raw = "";
      for await (const chunk of req) raw += chunk;
      pending = JSON.parse(raw);
      return json(200, { ok: true });
    }
    if (url.pathname === "/authorize") {
      // Tests read the nonce from the authorization URL; remember it per code.
      const code = randomUUID();
      nonces.set(code, url.searchParams.get("nonce") ?? "");
      return json(200, { code });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const code = new URLSearchParams(raw).get("code") ?? "";
      if (!pending) return json(400, { error: "invalid_grant" });
      const { iss, ...claims } = pending;
      pending = undefined;
      const now = Math.floor(Date.now() / 1000);
      return json(200, {
        access_token: randomUUID(),
        token_type: "Bearer",
        expires_in: 3600,
        id_token: idToken({ iss: iss ?? opts.issuerOverride ?? base, aud: opts.clientId, iat: now, exp: now + 300, nonce: nonces.get(code), ...claims }),
      });
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    issuer: opts.issuerOverride ?? base,
    discoveryUrl: `${base}/.well-known/openid-configuration`,
    nextLogin: (claims) => {
      pending = claims;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Collects `name=value` pairs from Set-Cookie headers into one Cookie header. */
export function cookieHeader(res: Response, previous = ""): string {
  const jar = new Map(previous ? previous.split("; ").map((c) => c.split("=", 2) as [string, string]) : []);
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const i = pair!.indexOf("=");
    jar.set(pair!.slice(0, i), pair!.slice(i + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}
