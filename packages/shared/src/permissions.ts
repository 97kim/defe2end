/** Workspace roles (contract section 4). */
export const ROLES = ["ADMIN", "EDITOR", "VIEWER"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Every permission check names one of these. Workspace actions are judged by the
 * membership role; instance actions by `isInstanceAdmin`.
 */
export const WORKSPACE_ACTIONS = {
  /** Read the workspace, sites, environments, variables (secrets masked), scenarios, members. */
  "workspace.read": ["VIEWER", "EDITOR", "ADMIN"],
  /** Create, edit, duplicate, archive, tag, import and export scenarios. */
  "scenario.write": ["EDITOR", "ADMIN"],
  /** Write sites, environments and variables. */
  "config.write": ["EDITOR", "ADMIN"],
  /** Members and roles, invites, rename or delete the workspace. */
  "workspace.admin": ["ADMIN"],
  /** Read runs, step results and artifacts. */
  "run.read": ["VIEWER", "EDITOR", "ADMIN"],
  /** Start runs (single, group, test run, re-run). */
  "run.create": ["EDITOR", "ADMIN"],
  /** Cancel a queued or running run. */
  "run.cancel": ["EDITOR", "ADMIN"],
  /** Stop every queued and running run of the workspace. */
  "run.stopAll": ["ADMIN"],
  /** Upload and delete workspace attachments (`upload` action files). */
  "attachment.write": ["EDITOR", "ADMIN"],
  /** Save and delete one's own target-site login sessions (stage 4 contract section 5). The caller checks ownership. */
  "authSession.write": ["EDITOR", "ADMIN"],
  /** Set and clear one's own value of a personal variable (variables contract section 2). The caller checks ownership. */
  "variable.personal.write": ["EDITOR", "ADMIN"],
  /** Schedules: create, edit, enable/disable, delete, their own variable values and login sessions (stage 5 section 9). */
  "schedule.write": ["EDITOR", "ADMIN"],
  /** Slack webhooks and daily reports. */
  "notification.write": ["ADMIN"],
  /** Bot tokens for `/api/v1`, their own variable values and login sessions. */
  "botToken.write": ["ADMIN"],
} as const satisfies Record<string, readonly Role[]>;

export const INSTANCE_ACTIONS = ["workspace.create", "user.list", "user.resetLink", "user.disable"] as const;

/**
 * Allowed to every active user, on the instance (no workspace). Disabled users never get an `Actor`.
 * `desktop.connect`: exchange a desktop token and open the stream (stage 4 contract section 3).
 */
export const USER_ACTIONS = ["desktop.connect"] as const;

export type WorkspaceAction = keyof typeof WORKSPACE_ACTIONS;
export type InstanceAction = (typeof INSTANCE_ACTIONS)[number];
export type UserAction = (typeof USER_ACTIONS)[number];
export type Action = WorkspaceAction | InstanceAction | UserAction;
export const ACTIONS = [...(Object.keys(WORKSPACE_ACTIONS) as WorkspaceAction[]), ...INSTANCE_ACTIONS, ...USER_ACTIONS];

export type ResourceType =
  | "workspace"
  | "member"
  | "invite"
  | "site"
  | "environment"
  | "variable"
  | "scenario"
  | "tag"
  | "run"
  | "artifact"
  | "attachment"
  | "authSession"
  | "desktopDevice"
  | "schedule"
  | "notification"
  | "botToken"
  | "instance";

export interface Actor {
  userId: string;
  isInstanceAdmin: boolean;
  /** Membership role per workspace id. */
  roles: Record<string, Role>;
}

/** Instance resources have no `workspaceId`. */
export interface Resource {
  type: ResourceType;
  workspaceId?: string;
}

/** `not_found` maps to HTTP 404 (never reveal other workspaces), `forbidden` to 403. */
export type Decision = "allow" | "forbidden" | "not_found";

export function isWorkspaceAction(action: Action): action is WorkspaceAction {
  return Object.hasOwn(WORKSPACE_ACTIONS, action);
}

/** The single permission check every entry point goes through. Pure. */
export function can(actor: Actor, action: Action, resource: Resource): Decision {
  if ((USER_ACTIONS as readonly string[]).includes(action)) return resource.workspaceId === undefined ? "allow" : "forbidden";
  if (!isWorkspaceAction(action)) {
    if (resource.workspaceId !== undefined) return "forbidden";
    return actor.isInstanceAdmin ? "allow" : "forbidden";
  }
  // Instance admins get no silent bypass: inside a workspace only the membership counts.
  const role = resource.workspaceId === undefined ? undefined : actor.roles[resource.workspaceId];
  if (!role) return "not_found";
  return (WORKSPACE_ACTIONS[action] as readonly Role[]).includes(role) ? "allow" : "forbidden";
}
