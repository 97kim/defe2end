import { beforeEach, expect, it } from "vitest";
import { POST } from "../app/api/workspaces/route";
import { describeDb, resetDatabase } from "../test/db";
import { callRoute, createUser, sessionHeaders } from "../test/helpers";
import { getDb } from "./db";

describeDb("POST /api/workspaces", () => {
  beforeEach(resetDatabase);

  const create = async (userId: string, body: unknown) => callRoute(POST, { method: "POST", body, headers: await sessionHeaders(userId) });

  it("lets an instance admin create a workspace and makes them its ADMIN", async () => {
    const admin = await createUser({ isInstanceAdmin: true });
    const res = await create(admin.id, { name: "  Second Shop " });
    expect(res.status).toBe(201);
    const ws = await res.json();
    expect(ws).toEqual({ id: expect.any(String), name: "Second Shop", slug: "second-shop" });
    const membership = await getDb().membership.findUnique({ where: { userId_workspaceId: { userId: admin.id, workspaceId: ws.id } } });
    expect(membership?.role).toBe("ADMIN");
    expect(await getDb().auditLog.count({ where: { action: "workspace.create", targetId: ws.id } })).toBe(1);
  });

  it("works after the admin deleted their only workspace", async () => {
    const admin = await createUser({ isInstanceAdmin: true });
    const first = await (await create(admin.id, { name: "Only" })).json();
    await getDb().workspace.delete({ where: { id: first.id } });
    const res = await create(admin.id, { name: "Fresh start" });
    expect(res.status).toBe(201);
  });

  it("gives a clashing name a different slug", async () => {
    const admin = await createUser({ isInstanceAdmin: true });
    const a = await (await create(admin.id, { name: "Shop" })).json();
    const b = await (await create(admin.id, { name: "Shop" })).json();
    expect(a.slug).toBe("shop");
    expect(b.slug).toMatch(/^shop-[0-9a-f]{6}$/);
  });

  it("refuses non-admins and invalid names", async () => {
    const user = await createUser();
    expect((await create(user.id, { name: "Mine" })).status).toBe(403);
    expect(await getDb().workspace.count()).toBe(0);
    const admin = await createUser({ isInstanceAdmin: true });
    expect((await create(admin.id, { name: "  " })).status).toBe(400);
  });
});
