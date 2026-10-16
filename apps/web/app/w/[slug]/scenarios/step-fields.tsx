"use client";

import { useTranslations } from "next-intl";
import { useRef, useState, type ReactNode } from "react";
import { attachmentToken, parseUploadToken, uploadTokens } from "@defe2end/shared";
import { Button, Dialog, inputClass } from "../../../../components/ui";
import { EDITOR_ACTIONS, fieldsFor, isRequired, NO_INPUT_NOTE, type EditorAction, type FieldDef, type StepLike } from "../../../../lib/step-fields";

const monoInput = `${inputClass} font-mono text-code`;

/** Field labels come from the table as plain keys; next-intl's key types can't follow them. */
type Translate = (key: string) => string;
const useFieldText = () => useTranslations("scenarios.stepFields") as unknown as Translate;

type Props<S extends StepLike> = {
  step: S;
  /** Messages from the shared schema, by field key (see `issuesByField`). */
  errors?: Record<string, string>;
  slug: string;
  onChange: (patch: Partial<S>) => void;
};

/** Action picker: one flat list with the spec's labels, in its order (section 3). */
export function ActionPicker({ id, value, onChange }: { id: string; value: string; onChange: (action: EditorAction) => void }) {
  const t = useTranslations("scenarios") as unknown as Translate;
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value as EditorAction)} className={inputClass}>
      {EDITOR_ACTIONS.map((a) => (
        <option key={a} value={a}>
          {t(`actions.${a}`)}
        </option>
      ))}
    </select>
  );
}

/** Step name, optional flag and the action's own fields. */
export function StepFields<S extends StepLike>({ step, errors = {}, slug, onChange }: Props<S>) {
  const t = useFieldText();
  const fields = fieldsFor(step);
  const id = (key: string) => `step-${String(step.id)}-${key}`;
  const note = NO_INPUT_NOTE[step.action as EditorAction];
  return (
    <div className="flex flex-col gap-3">
      <FieldShell id={id("name")} label={t("label.name")} error={errors.name}>
        <input id={id("name")} value={String(step.name ?? "")} placeholder={t("label.namePlaceholder")} maxLength={200} onChange={(e) => onChange({ name: e.target.value } as unknown as Partial<S>)} className={inputClass} />
      </FieldShell>
      <label className="inline-flex items-center gap-2 text-body">
        <input type="checkbox" checked={step.optional === true} onChange={(e) => onChange({ optional: e.target.checked } as unknown as Partial<S>)} className="size-4 accent-accent" />
        {t("label.optional")}
      </label>
      {fields.length === 0 && <p className="text-meta text-text-muted">{note ? `${t("note.noInputs")} ${t(`note.${note}`)}` : t("note.noInputs")}</p>}
      {fields.map((f) => (
        <FieldInput key={f.key} field={f} step={step} required={isRequired(f, step)} error={errors[f.key]} id={id(f.key)} slug={slug} onChange={onChange} />
      ))}
    </div>
  );
}

function FieldInput<S extends StepLike>({ field, step, required, error, id, slug, onChange }: { field: FieldDef; step: S; required: boolean; error?: string; id: string; slug: string; onChange: (patch: Partial<S>) => void }) {
  const t = useFieldText();
  const set = (value: unknown) => onChange({ [field.key]: value } as unknown as Partial<S>);
  const describedBy = error ? `${id}-error` : undefined;
  const common = { id, "aria-invalid": error ? true : undefined, "aria-required": required || undefined, "aria-describedby": describedBy };
  const raw = step[field.key];
  let control: ReactNode;
  if (field.type === "number") {
    control = (
      <input
        {...common}
        type="number"
        inputMode="numeric"
        min={0}
        value={raw === undefined || raw === null ? "" : String(raw)}
        onChange={(e) => set(e.target.value === "" ? undefined : Number(e.target.value))}
        className={`${monoInput} max-w-48`}
      />
    );
  } else if (field.type === "coordinates") {
    const pos = (raw ?? {}) as { x?: number; y?: number };
    const axis = (k: "x" | "y") => (
      <label className="inline-flex items-center gap-1.5 text-meta text-text-muted">
        {t(k === "x" ? "label.positionX" : "label.positionY")}
        <input
          {...common}
          id={k === "x" ? id : `${id}-y`}
          type="number"
          step={1}
          placeholder={k.toUpperCase()}
          value={pos[k] ?? ""}
          onChange={(e) => {
            const next = { ...pos, [k]: e.target.value === "" ? undefined : Number(e.target.value) };
            set(next.x === undefined && next.y === undefined ? undefined : next);
          }}
          className={`${monoInput} w-24`}
        />
      </label>
    );
    control = (
      <span className="flex gap-3">
        {axis("x")}
        {axis("y")}
      </span>
    );
  } else {
    control = (
      <span className="flex gap-2">
        <input
          {...common}
          value={raw === undefined || raw === null ? "" : String(raw)}
          maxLength={10000}
          spellCheck={false}
          onChange={(e) => set(e.target.value)}
          className={monoInput}
        />
        {field.type === "fileUrl" && <UploadButton slug={slug} onUploaded={(names) => set(names.map(attachmentToken).join(", "))} />}
        {field.type === "fileUrl" && <GenerateImageButton slug={slug} onUploaded={(name) => set(attachmentToken(name))} />}
      </span>
    );
    if (field.type === "fileUrl") control = <span className="flex flex-col gap-2">{control}<AttachmentChips value={raw === undefined || raw === null ? "" : String(raw)} onChange={set} /></span>;
  }
  return (
    <FieldShell id={id} label={t(`label.${field.label}`)} required={required} error={error}>
      {control}
    </FieldShell>
  );
}

function FieldShell({ id, label, required, error, children }: { id: string; label: string; required?: boolean; error?: string; children: ReactNode }) {
  const t = useFieldText();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-meta font-semibold">
        {label}
        {required && (
          <span className="ml-1 text-fail" title={t("required")}>
            *<span className="sr-only">{t("required")}</span>
          </span>
        )}
      </label>
      {children}
      {error && (
        <span id={`${id}-error`} role="alert" className="text-meta text-fail">
          {error}
        </span>
      )}
    </div>
  );
}

/** `attachment:<name>` tokens of an uploadFile value, shown by file name; × takes the token out of the value. */
function AttachmentChips({ value, onChange }: { value: string; onChange: (next: string | undefined) => void }) {
  const t = useFieldText();
  const tokens = uploadTokens(value);
  const chips = tokens.flatMap((token, index) => {
    const parsed = parseUploadToken(token);
    return parsed.kind === "attachment" ? [{ index, name: parsed.name }] : [];
  });
  if (chips.length === 0) return null;
  return (
    <ul aria-label={t("attachments")} className="flex flex-wrap gap-1.5">
      {chips.map(({ index, name }) => (
        <li key={index} className="flex items-center gap-1 rounded-control border border-border-strong bg-bg-subtle px-2 py-0.5 text-meta">
          <span className="font-semibold">{t("attachment")}</span>
          <span className="max-w-64 truncate" title={name}>
            {name}
          </span>
          <button
            type="button"
            aria-label={`${t("removeAttachment")}: ${name}`}
            onClick={() => {
              const next = tokens.filter((_, i) => i !== index).join(" ");
              onChange(next === "" ? undefined : next);
            }}
            className="px-1 text-muted hover:text-text"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Uploads one file to the workspace attachments; the stored name, or the error to show. */
async function uploadAttachment(slug: string, file: File): Promise<{ name?: string; error?: string }> {
  const form = new FormData();
  form.set("file", file);
  const res = await fetch(`/api/w/${slug}/attachments/upload`, { method: "POST", body: form }).catch(() => null);
  const body = res ? await res.json().catch(() => null) : null;
  return res?.ok && body?.name ? { name: body.name } : { error: body?.error?.message };
}

/**
 * "Upload": picks image files, uploads them one by one in the picked order and replaces the value with their
 * `attachment:<name>` tokens joined by ", " (spec 3.1). On a failure the value stays as it was.
 */
function UploadButton({ slug, onUploaded }: { slug: string; onUploaded: (names: string[]) => void }) {
  const t = useFieldText();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  async function upload(files: File[]) {
    setBusy(true);
    setFailed(undefined);
    const names: string[] = [];
    for (const file of files) {
      const { name, error } = await uploadAttachment(slug, file);
      if (!name) {
        setBusy(false);
        return setFailed(error ?? t("uploadFailed"));
      }
      names.push(name);
    }
    setBusy(false);
    onUploaded(names);
  }
  return (
    <>
      <button type="button" title={t("uploadTitle")} disabled={busy} onClick={() => input.current?.click()} className="h-9 shrink-0 rounded-control border border-border-strong px-3 text-body font-semibold hover:bg-bg-subtle disabled:opacity-50">
        {busy ? t("uploading") : t("upload")}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) void upload(files);
        }}
      />
      {failed && (
        <span role="alert" className="self-center text-meta text-fail">
          {failed}
        </span>
      )}
    </>
  );
}

const IMAGE_SIDE_MAX = 4096;
const validSide = (text: string) => /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= IMAGE_SIDE_MAX;

/** A PNG of `width`×`height`: black, with the size in white bold type in the middle (spec 3.1 uploadFile). */
async function testImage(width: number, height: number): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.max(12, Math.round(Math.min(width, height) * 0.12))}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`${width}×${height}`, width / 2, height / 2);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("canvas");
  return new File([blob], `test-${width}x${height}.png`, { type: "image/png" });
}

/** "Generate": asks for a size, makes the test image, uploads it and puts its token in the value (replacing it). */
function GenerateImageButton({ slug, onUploaded }: { slug: string; onUploaded: (name: string) => void }) {
  const t = useFieldText();
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState("750");
  const [height, setHeight] = useState("900");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const valid = validSide(width) && validSide(height);
  async function generate() {
    if (!valid || busy) return;
    setBusy(true);
    setFailed(undefined);
    const result = await testImage(Number(width), Number(height)).then(
      (file) => uploadAttachment(slug, file),
      () => ({ name: undefined, error: undefined }),
    );
    setBusy(false);
    if (!result.name) return setFailed(result.error ?? t("uploadFailed"));
    setOpen(false);
    onUploaded(result.name);
  }
  const side = (label: string, value: string, onChange: (v: string) => void, autoFocus?: boolean) => (
    <label className="flex flex-1 flex-col gap-1 text-meta font-semibold">
      {label}
      <input type="number" min={1} max={IMAGE_SIDE_MAX} step={1} placeholder={label} value={value} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} className={monoInput} />
    </label>
  );
  return (
    <>
      <button type="button" title={t("generateTooltip")} onClick={() => (setFailed(undefined), setOpen(true))} className="h-9 shrink-0 rounded-control border border-border-strong px-3 text-body font-semibold hover:bg-bg-subtle">
        {t("generate")}
      </button>
      {open && (
        <Dialog
          title={t("generateTitle")}
          onClose={() => !busy && setOpen(false)}
          onSubmit={() => void generate()}
          footer={
            <Button type="submit" disabled={!valid || busy}>
              {busy ? t("uploading") : t("generateCreate")}
            </Button>
          }
        >
          <div className="flex gap-3">
            {side(t("width"), width, setWidth, true)}
            {side(t("height"), height, setHeight)}
          </div>
          <p className="text-meta text-text-muted">{t("generateHelp")}</p>
          {failed && (
            <span role="alert" className="text-meta text-fail">
              {failed}
            </span>
          )}
        </Dialog>
      )}
    </>
  );
}
