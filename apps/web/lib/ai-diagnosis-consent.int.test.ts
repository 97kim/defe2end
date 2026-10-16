// Stage 6 contract section 8: the AI diagnosis consent is asked once per user and kept on the server.
import { beforeEach, expect, it } from "vitest";
import * as consentRoute from "../app/api/account/ai-diagnosis-consent/route";
import { describeDb, resetDatabase } from "../test/db";
import { callRoute, createUser, sessionHeaders } from "../test/helpers";
import { getDb } from "./db";

describeDb("AI diagnosis consent", () => {
  let me: { id: string };
  let other: { id: string };
  beforeEach(async () => {
    await resetDatabase();
    me = await createUser();
    other = await createUser();
  });

  const call = async (method: "GET" | "POST" | "DELETE", userId = me.id, extra?: Record<string, string>) => {
    const headers = await sessionHeaders(userId);
    for (const [k, v] of Object.entries(extra ?? {})) headers.set(k, v);
    return callRoute(consentRoute[method], { method, path: "/api/account/ai-diagnosis-consent", headers });
  };
  const consentOf = async (id: string) => (await getDb().user.findUniqueOrThrow({ where: { id } })).aiDiagnosisConsentAt;

  it("starts empty, records once, keeps the first time and touches no one else", async () => {
    expect(await (await call("GET")).json()).toEqual({ consentedAt: null });
    const first = await (await call("POST")).json();
    expect(first.consentedAt).toEqual(expect.any(String));
    expect(await (await call("POST")).json()).toEqual(first);
    expect(await (await call("GET")).json()).toEqual(first);
    expect(await consentOf(other.id)).toBeNull();
    expect(await (await call("GET", other.id)).json()).toEqual({ consentedAt: null });
  });

  it("withdrawing clears only the caller's consent", async () => {
    await call("POST");
    await call("POST", other.id);
    expect(await (await call("DELETE")).json()).toEqual({ consentedAt: null });
    expect(await consentOf(me.id)).toBeNull();
    expect(await consentOf(other.id)).not.toBeNull();
  });

  it("refuses the signed-out and MCP tokens", async () => {
    for (const method of ["GET", "POST", "DELETE"] as const) {
      expect((await callRoute(consentRoute[method], { method })).status).toBe(401);
      expect((await call(method, me.id, { authorization: "Bearer mcp_abc" })).status).toBe(403);
    }
    expect(await consentOf(me.id)).toBeNull();
  });
});
