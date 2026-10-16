// Stage 6 contract sections 5 and 8: what is hidden before page content leaves the machine — the failure-diagnosis
// payload (sent to an external AI) and browser tool replies (read by the AI). Dependency-free and DOM-free so the
// runner, the desktop app and the server can all use it on plain strings.
//
// Limits (say so in the docs): values are found by pattern, not by meaning. A secret rendered as page text is hidden
// only when its value is passed in `secrets`; the app doesn't know secret values, so browser replies rely on the
// structural rules alone. HTML entities in text are not decoded, so an entity-encoded email may slip through.
import { maskSecrets, SECRET_MASK } from "./mask.js";

/** What hidden things are replaced with. Emails and phone numbers keep a hint of what was there. */
export const REDACTED = { value: SECRET_MASK, email: "[email]", phone: "[phone]" } as const;

export interface RedactOptions {
  /** Secret variable values to hide wherever they appear (also in their HTML-escaped form inside `redactDom`). */
  secrets?: Iterable<string>;
}

// Bounded repeats (RFC lengths: local part 64, label 63) keep this linear: with `+`, a long run of letters or
// digits with no "@" was retried from every position, so 50,000 characters took seconds.
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g;
// Phone numbers need a shape that dates, times, prices and long ids don't have: an international prefix, a Korean
// area/mobile code with separators, a Korean mobile number written solid, or a US `(415) 555-1234`.
const PHONE = new RegExp(
  [
    String.raw`\+\d{1,3}[ .-]?\(?\d{1,4}\)?[ .-]?\d{3,4}[ .-]?\d{4}`,
    String.raw`0\d{1,2}[ .-]\d{3,4}[ .-]\d{4}`,
    String.raw`01[016789]\d{7,8}`,
    String.raw`\(\d{3}\) ?\d{3}[ .-]\d{4}`,
  ]
    .map((p) => String.raw`(?<![\w+])${p}(?!\w)`)
    .join("|"),
  "g",
);
const ABSOLUTE_URL = /\b(?:https?|wss?|ftp):\/\/[^\s"'<>`]+/gi;
const URL_TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/**
 * Keeps scheme, host and path; hides query values (`?q=a&b` → `?q=••••••&••••••`, key names stay), credentials in
 * the authority, and fragment values when the fragment looks like parameters (`#access_token=…`). Plain anchors stay.
 * Works on relative URLs too.
 */
export function redactUrl(url: string): string {
  let rest = url;
  let fragment = "";
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    fragment = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  let query: string | null = null;
  const q = rest.indexOf("?");
  if (q >= 0) {
    query = rest.slice(q + 1);
    rest = rest.slice(0, q);
  }
  rest = rest.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, `$1${SECRET_MASK}@`);
  let out = rest;
  if (query !== null) out += "?" + redactParams(query);
  if (hash >= 0) out += "#" + (fragment.includes("=") ? redactParams(fragment) : fragment);
  return out;
}

function redactParams(params: string): string {
  return params
    .split("&")
    .map((part) => {
      if (part === "") return part;
      const eq = part.indexOf("=");
      if (eq < 0) return SECRET_MASK;
      return eq === part.length - 1 ? part : `${part.slice(0, eq)}=${SECRET_MASK}`;
    })
    .join("&");
}

/** Hides secret values, URL query/fragment values and credentials, emails and phone numbers in free text. */
export function redactText(text: string, options: RedactOptions = {}): string {
  let out = options.secrets ? maskSecrets(text, options.secrets) : text;
  out = out.replace(ABSOLUTE_URL, (match) => {
    const trailing = URL_TRAILING_PUNCTUATION.exec(match)?.[0] ?? "";
    return redactUrl(match.slice(0, match.length - trailing.length)) + trailing;
  });
  out = out.replace(EMAIL, REDACTED.email);
  out = out.replace(PHONE, REDACTED.phone);
  return out;
}

const FORM_FIELDS = new Set(["input", "textarea", "select"]);
/** Elements whose content is never kept: the textarea content is its value; scripts and styles carry page state. */
const DROP_CONTENT = new Set(["textarea", "script", "style"]);
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster", "cite", "data", "srcset", "background", "ping"]);
/** Test hooks are selectors, not data, so they are kept even when they contain numbers. */
const KEPT_DATA_ATTRIBUTES = new Set(["data-testid", "data-test-id", "data-test", "data-qa", "data-cy"]);
const SENSITIVE_AUTOCOMPLETE = new Set(["current-password", "new-password", "one-time-code"]);
/**
 * A `data-*` value is kept only when it reads as a label rather than a value: empty, or one identifier-like word
 * (starts with a letter, ≤ 64 of letters/digits/`_:.-`) with no run of 4+ digits. Anything else — numbers, ids,
 * spaces, JSON, emails, URLs — is replaced.
 */
const LABEL_LIKE = /^[A-Za-z][A-Za-z0-9_:.-]{0,63}$/;
export function isLabelLikeDataValue(value: string): boolean {
  return value === "" || (LABEL_LIKE.test(value) && !/\d{4,}/.test(value));
}

const TOKEN = /<!--[\s\S]*?(?:-->|$)|<(\/?)([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

interface Attribute {
  name: string;
  value: string | null;
}

function parseAttributes(source: string): Attribute[] {
  const attrs: Attribute[] = [];
  for (const m of source.matchAll(ATTRIBUTE)) attrs.push({ name: m[1]!, value: m[2] ?? m[3] ?? m[4] ?? null });
  return attrs;
}

function isSensitiveField(tag: string, attrs: Attribute[]): boolean {
  if (!FORM_FIELDS.has(tag)) return false;
  const get = (n: string) => attrs.find((a) => a.name.toLowerCase() === n)?.value?.toLowerCase() ?? "";
  if (get("type") === "password") return true;
  return get("autocomplete")
    .split(/\s+/)
    .some((t) => t.startsWith("cc-") || SENSITIVE_AUTOCOMPLETE.has(t));
}

function escapeAttribute(value: string): string {
  return value.replace(/"/g, "&quot;");
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Masks an HTML string (a DOM summary or an outerHTML excerpt) without parsing it into a DOM:
 * - `value` is dropped from input/textarea/select; textarea content is dropped; script/style content is dropped;
 *   comments are dropped.
 * - password inputs and fields with `autocomplete` `cc-*`/`current-password`/`new-password`/`one-time-code` also
 *   lose their content (a sensitive select keeps no options).
 * - `data-*` values that don't look like labels (`isLabelLikeDataValue`) become `••••••`; test-hook attributes stay.
 * - URL attributes go through `redactUrl` (relative URLs too); every remaining attribute value and all text go
 *   through `redactText`.
 * Attributes are re-serialized with double quotes. Malformed markup is treated as text.
 */
export function redactDom(html: string, options: RedactOptions = {}): string {
  const secrets = options.secrets ? [...options.secrets].filter((s) => s.length > 0) : [];
  const textOptions: RedactOptions = { secrets: [...secrets, ...secrets.map(escapeHtmlText)] };
  const text = (s: string) => redactText(s, textOptions);
  let out = "";
  let last = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(html); m; m = TOKEN.exec(html)) {
    out += text(html.slice(last, m.index));
    last = TOKEN.lastIndex;
    if (m[2] === undefined) continue; // comment
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const rawAttrs = m[3] ?? "";
    if (closing) {
      out += `</${m[2]}>`;
      continue;
    }
    const attrs = parseAttributes(rawAttrs);
    const sensitive = isSensitiveField(tag, attrs);
    let tagOut = `<${m[2]}`;
    for (const { name, value } of attrs) {
      const lower = name.toLowerCase();
      if (lower === "value" && FORM_FIELDS.has(tag)) continue;
      if (value === null) {
        tagOut += ` ${name}`;
        continue;
      }
      let masked: string;
      if (lower.startsWith("data-") && !KEPT_DATA_ATTRIBUTES.has(lower) && !isLabelLikeDataValue(value)) masked = SECRET_MASK;
      else if (URL_ATTRIBUTES.has(lower)) masked = text(redactUrl(value));
      else masked = text(value);
      tagOut += ` ${name}="${escapeAttribute(masked)}"`;
    }
    const selfClosing = /\/\s*$/.test(rawAttrs);
    tagOut += selfClosing ? " />" : ">";
    out += tagOut;
    if (selfClosing || !(DROP_CONTENT.has(tag) || (sensitive && tag === "select"))) continue;
    // Skip to the matching close tag (or the end) and keep nothing in between.
    const close = new RegExp(`</${tag}\\s*>`, "ig");
    close.lastIndex = last;
    const end = close.exec(html);
    if (end) {
      out += end[0];
      last = close.lastIndex;
    } else {
      last = html.length;
    }
    TOKEN.lastIndex = last;
  }
  out += text(html.slice(last));
  return out;
}
