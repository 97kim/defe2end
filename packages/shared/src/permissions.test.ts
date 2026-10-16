import { describe, expect, it } from "vitest";
import { ACTIONS, can, type Action, type Actor, type Decision, type Role } from "./index.js";

const WS = "ws-1";
const OTHER = "ws-2";

type Who = Role | "NON_MEMBER";
const WHO: Who[] = ["VIEWER", "EDITOR", "ADMIN", "NON_MEMBER"];

// Contract section 4, written out by hand so a change to the code has to change this table too.
// Columns: VIEWER, EDITOR, ADMIN, NON_MEMBER — for a workspace resource.
const A = "allow", F = "forbidden", N = "not_found";
const WORKSPACE_TABLE: Record<Action, [Decision, Decision, Decision, Decision]> = {
  "workspace.read": [A, A, A, N],
  "scenario.write": [F, A, A, N],
  "config.write": [F, A, A, N],
  "workspace.admin": [F, F, A, N],
  "run.read": [A, A, A, N],
  "run.create": [F, A, A, N],
  "run.cancel": [F, A, A, N],
  "run.stopAll": [F, F, A, N],
  "attachment.write": [F, A, A, N],
  "authSession.write": [F, A, A, N],
  "variable.personal.write": [F, A, A, N],
  "schedule.write": [F, A, A, N],
  "notification.write": [F, F, A, N],
  "botToken.write": [F, F, A, N],
  // Instance actions are never allowed against a workspace resource.
  "workspace.create": [F, F, F, F],
  "user.list": [F, F, F, F],
  "user.resetLink": [F, F, F, F],
  "user.disable": [F, F, F, F],
  // User actions are never allowed against a workspace resource either.
  "desktop.connect": [F, F, F, F],
};

// Instance resource (no workspaceId): [regular user, instance admin].
const INSTANCE_TABLE: Record<Action, [Decision, Decision]> = {
  "workspace.read": [N, N],
  "scenario.write": [N, N],
  "config.write": [N, N],
  "workspace.admin": [N, N],
  "run.read": [N, N],
  "run.create": [N, N],
  "run.cancel": [N, N],
  "run.stopAll": [N, N],
  "attachment.write": [N, N],
  "authSession.write": [N, N],
  "variable.personal.write": [N, N],
  "schedule.write": [N, N],
  "notification.write": [N, N],
  "botToken.write": [N, N],
  "workspace.create": [F, A],
  "user.list": [F, A],
  "user.resetLink": [F, A],
  "user.disable": [F, A],
  // Every active user.
  "desktop.connect": [A, A],
};

function actor(who: Who, isInstanceAdmin: boolean): Actor {
  // Every actor is a member elsewhere, so "non-member" really tests the other-workspace case.
  const roles: Record<string, Role> = { [OTHER]: "ADMIN" };
  if (who !== "NON_MEMBER") roles[WS] = who;
  return { userId: "u", isInstanceAdmin, roles };
}

describe("can", () => {
  it("the tables cover every action", () => {
    expect(Object.keys(WORKSPACE_TABLE).sort()).toEqual([...ACTIONS].sort());
    expect(Object.keys(INSTANCE_TABLE).sort()).toEqual([...ACTIONS].sort());
  });

  for (const action of ACTIONS) {
    for (const isInstanceAdmin of [false, true]) {
      WHO.forEach((who, i) => {
        // Instance admins are judged by their membership role inside a workspace (no bypass).
        it(`${action} on a workspace resource: ${who}${isInstanceAdmin ? " (instance admin)" : ""}`, () => {
          expect(can(actor(who, isInstanceAdmin), action, { type: "workspace", workspaceId: WS })).toBe(
            WORKSPACE_TABLE[action][i],
          );
        });
      });
      it(`${action} on the instance: ${isInstanceAdmin ? "instance admin" : "user"}`, () => {
        expect(can(actor("ADMIN", isInstanceAdmin), action, { type: "instance" })).toBe(
          INSTANCE_TABLE[action][isInstanceAdmin ? 1 : 0],
        );
      });
    }
  }
});
