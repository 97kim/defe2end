import { Prisma, type Environment, type Site, type Variable } from "@defe2end/db";
import { isValidTimeZone, maskSecrets, parseMaskSelectorList } from "@defe2end/shared";
import { z } from "zod";
import { ApiError } from "./api";

// Sites, environments and variables (contract sections 3 and 6). Shared by the API routes and the settings pages.

export const VARIABLE_KEY_PATTERN = /^[A-Za-z0-9_]+$/;
export const MAX_VARIABLE_VALUE = 10_000;

const name = z.string().trim().min(1, "Name is required").max(100, "Name is too long");

export const workspaceRenameSchema = z.object({ name });
/** Workspace PATCH: any of the name, the message language (Slack) and the time zone (IANA). */
export const WORKSPACE_LOCALES = ["en", "ko"] as const;
export const workspaceUpdateSchema = z
  .object({ name, locale: z.enum(WORKSPACE_LOCALES), timezone: z.string().refine(isValidTimeZone, "Unknown time zone") })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");
export const workspaceDeleteSchema = z.object({ confirmName: z.string() });

export const siteInputSchema = z.object({ name });
/** Site PATCH: the name and/or the masking selector list (stage 7 contract section 5). */
export const siteUpdateSchema = z
  .object({ name, maskSelectors: z.string().max(100_000) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");

/**
 * Checks a mask selector list on save: an invalid item refuses the whole save with 400 and its position.
 * `label` names the list in the message ("Mask selector", "Step 3 mask").
 */
export function assertMaskSelectors(text: string, label = "Mask selector"): void {
  const checked = parseMaskSelectorList(text);
  if (!checked.ok) throw new ApiError("invalid_request", `${label} ${checked.position} is not a valid CSS selector (${checked.selector}): ${checked.reason}`);
}

const baseUrl = z
  .string()
  .trim()
  .max(2000, "Base URL is too long")
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Base URL must be an http or https URL without credentials");

export const environmentCreateSchema = z.object({ name, baseUrl, useAuthSession: z.boolean().default(false) });
/** `useAuthSession`: runs need the requester's own login session (stage 4 contract section 5). */
export const environmentUpdateSchema = z.object({ name: name.optional(), baseUrl: baseUrl.optional(), useAuthSession: z.boolean().optional() });

const key = z.string().trim().min(1, "Key is required").max(64, "Key is too long").regex(VARIABLE_KEY_PATTERN, "Key must use only letters, digits and _");
const value = z.string().max(MAX_VARIABLE_VALUE, "Value is too long");

const scope = z.enum(["shared", "personal"]);

/** A personal variable is a definition only: everyone sets their own value with `PUT …/mine`. */
export const variableCreateSchema = z
  .object({ key, value: value.default(""), isSecret: z.boolean().default(false), scope: scope.default("shared") })
  .refine((v) => v.scope === "personal" || !v.isSecret || v.value.length > 0, "A secret needs a value");
export const variableUpdateSchema = z.object({ key: key.optional(), value: value.optional(), isSecret: z.boolean().optional(), scope: scope.optional() });
export const personalValueSchema = z.object({ value });

/** What the API and pages expose. A secret's value never leaves the server (write-only). */
export interface VariableView {
  id: string;
  key: string;
  isSecret: boolean;
  scope: "shared" | "personal";
  /** Shared value (null for secrets and personal variables). */
  value: string | null;
  hasValue: boolean;
  /** Personal variables only: the caller's own value — never anyone else's, nor whether they set one. */
  mine?: { hasValue: boolean; value?: string };
}

type MyValue = { value: string | null; valueEncrypted: string | null } | null | undefined;

/** `mine`: the caller's PersonalVariableValue row of this variable, if any (load only the caller's). */
export function variableView(v: Variable, mine?: MyValue): VariableView {
  if (v.scope === "personal") {
    const own = mine ? (v.isSecret ? { hasValue: mine.valueEncrypted !== null } : { hasValue: true, value: mine.value ?? "" }) : { hasValue: false };
    return { id: v.id, key: v.key, isSecret: v.isSecret, scope: "personal", value: null, hasValue: false, mine: own };
  }
  return v.isSecret
    ? { id: v.id, key: v.key, isSecret: true, scope: "shared", value: null, hasValue: v.valueEncrypted !== null }
    : { id: v.id, key: v.key, isSecret: false, scope: "shared", value: v.value ?? "", hasValue: true };
}

/** Include for loading variables with only `userId`'s own personal value. */
export const ownPersonalValue = (userId: string) => ({ personalValues: { where: { userId }, select: { value: true, valueEncrypted: true } } }) as const;

export function siteView(s: Site) {
  return { id: s.id, name: s.name, maskSelectors: s.maskSelectors };
}

export function environmentView(e: Environment) {
  return { id: e.id, siteId: e.siteId, name: e.name, baseUrl: e.baseUrl, useAuthSession: e.useAuthSession };
}

/**
 * Runs a write, mapping unique violations to 409 and hiding `secrets` from any other error
 * (Prisma errors can echo the query arguments, which the API wrapper logs).
 */
export async function writeOrConflict<T>(conflictMessage: string, fn: () => Promise<T>, secrets: string[] = []): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new ApiError("conflict", conflictMessage);
    if (secrets.length === 0) throw err;
    throw new Error(maskSecrets(err instanceof Error ? err.message : String(err), secrets));
  }
}

export const SITE_IN_USE = "Scenarios use this site. Move or delete them first";

/** Postgres 23503: a row still references the one being deleted (Prisma P2003 or the raw driver error). */
export function isForeignKeyViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") return true;
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown; originalCode?: unknown }).originalCode ?? (e as { code?: unknown }).code;
    if (code === "23503") return true;
  }
  return false;
}
