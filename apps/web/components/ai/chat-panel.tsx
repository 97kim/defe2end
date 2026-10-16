"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, Button, inputClass } from "../ui";
import { useAiBridge, useProviderStatus, type AiEvent, type Provider } from "./bridge";
import { ProviderNotices, useRefusalText, useTurnErrorText } from "./provider-notice";

// In-app AI chat (stage 6 contract section 7): a right-hand panel that folds away, only inside the desktop app.
// Threads live in this page's memory (and the app's), each keeps the provider of its first message.

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

interface Message {
  role: "user" | "assistant";
  text: string;
  error?: boolean;
  images?: number;
}
interface Thread {
  id: string;
  title: string;
  provider: Provider | null;
  messages: Message[];
  running: boolean;
}
interface Image {
  name: string;
  mediaType: string;
  base64: string;
}

const newThread = (): Thread => ({ id: crypto.randomUUID(), title: "", provider: null, messages: [], running: false });

function readImage(file: File): Promise<Image> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, mediaType: file.type, base64: String(reader.result).replace(/^data:[^,]*,/, "") });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function ChatPanel() {
  const t = useTranslations("ai");
  const bridge = useAiBridge();
  const { states, recheck, checking } = useProviderStatus(bridge);
  const errorText = useTurnErrorText();
  const refusalText = useRefusalText();
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState<Thread[]>(() => [newThread()]);
  const [currentId, setCurrentId] = useState<string>(() => threads[0]!.id);
  const [picked, setPicked] = useState<Provider | null>(null);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<Image[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  const current = threads.find((th) => th.id === currentId) ?? threads[0]!;
  const ready = (states ?? []).filter((s) => s.state === "ready").map((s) => s.provider);
  const provider = current.provider ?? (picked && ready.includes(picked) ? picked : (ready[0] ?? null));

  const update = (id: string, fn: (th: Thread) => Thread) => setThreads((list) => list.map((th) => (th.id === id ? fn(th) : th)));

  useEffect(() => {
    if (!bridge) return;
    return bridge.onEvent((event: AiEvent) => {
      const th = threadsRef.current.find((x) => x.id === event.threadId);
      if (!th) return;
      update(event.threadId, (x) => {
        const msgs = [...x.messages];
        const last = msgs.at(-1);
        const reply = last?.role === "assistant" && !last.error ? last : null;
        if (event.type === "delta") {
          if (reply) msgs[msgs.length - 1] = { ...reply, text: reply.text + event.text };
          else msgs.push({ role: "assistant", text: event.text });
          return { ...x, messages: msgs };
        }
        if (event.type === "done") {
          if (!reply && event.text) msgs.push({ role: "assistant", text: event.text });
          return { ...x, messages: msgs, running: false };
        }
        msgs.push({ role: "assistant", text: errorText(x.provider ?? "claude", event), error: true });
        return { ...x, messages: msgs, running: false };
      });
    });
  }, [bridge]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => scrollToEnd(bottom.current), [current.messages]);

  if (!bridge) return null;

  async function attach(files: FileList | null) {
    setNotice(null);
    const list = [...(files ?? [])];
    if (images.length + list.length > MAX_IMAGES) return setNotice(t("error.refused.too_many_images"));
    if (list.some((f) => !IMAGE_TYPES.includes(f.type))) return setNotice(t("error.refused.bad_image"));
    if (list.some((f) => f.size > MAX_IMAGE_BYTES)) return setNotice(t("error.refused.image_too_large"));
    const read = await Promise.all(list.map(readImage));
    setImages((imgs) => [...imgs, ...read]);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !provider || current.running) return;
    setNotice(null);
    const id = current.id;
    const result = await bridge!.send({ mode: "chat", threadId: id, provider, text, images: images.map(({ mediaType, base64 }) => ({ mediaType, base64 })) });
    if (!result.ok) return setNotice(refusalText(result.reason));
    update(id, (x) => ({
      ...x,
      provider,
      title: x.title || (text.length > 24 ? `${text.slice(0, 24)}…` : text),
      messages: [...x.messages, { role: "user", text, images: images.length }],
      running: true,
    }));
    setDraft("");
    setImages([]);
  }

  function startThread() {
    const th = newThread();
    setThreads((list) => [...list, th]);
    setCurrentId(th.id);
    setNotice(null);
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="fixed right-4 bottom-4 z-30 inline-flex h-10 items-center gap-2 rounded-full border border-border-strong bg-bg-surface px-4 text-body font-semibold text-text-primary shadow-e2 hover:bg-bg-subtle">
        {t("chat.open")}
      </button>
    );
  }

  return (
    <aside className="sticky top-0 flex h-screen w-[380px] shrink-0 flex-col border-l border-border bg-bg-surface" aria-label={t("chat.title")}>
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="flex-1 text-title-sm text-text-primary">{t("chat.title")}</h2>
        <Button type="button" variant="ghost" onClick={startThread}>
          {t("chat.newThread")}
        </Button>
        <Button type="button" variant="ghost" aria-label={t("chat.close")} onClick={() => setOpen(false)}>
          ×
        </Button>
      </header>
      {threads.length > 1 && (
        <div className="border-b border-border px-4 py-2">
          <select aria-label={t("chat.threads")} className={inputClass} value={current.id} onChange={(e) => setCurrentId(e.target.value)}>
            {threads.map((th) => (
              <option key={th.id} value={th.id}>
                {th.title || t("chat.untitled")}
                {th.provider ? ` · ${t(`provider.${th.provider}`)}` : ""}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="flex flex-col gap-3">
          <ProviderNotices states={states} checking={checking} onRecheck={recheck} />
          {current.messages.length === 0 && <p className="text-meta text-text-muted">{t("chat.empty")}</p>}
          {current.messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "self-end max-w-[85%] rounded-card bg-accent-soft px-3 py-2 text-body text-text-primary" : m.error ? "" : "max-w-full text-body text-text-primary"}>
              {m.error ? <Alert>{m.text}</Alert> : <p className="whitespace-pre-wrap break-words">{m.text}</p>}
              {m.images ? <p className="mt-1 text-meta text-text-muted">{t("chat.images", { count: m.images })}</p> : null}
            </div>
          ))}
          {current.running && current.messages.at(-1)?.role === "user" && <p className="text-meta text-text-muted">{t("chat.thinking")}</p>}
          <div ref={bottom} />
        </div>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-2 border-t border-border px-4 py-3">
        {notice && <Alert>{notice}</Alert>}
        {images.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {images.map((img, i) => (
              <li key={i} className="flex items-center gap-1 rounded-control border border-border bg-bg-subtle px-2 py-1 text-meta">
                <span className="max-w-32 truncate">{img.name}</span>
                <button type="button" aria-label={t("chat.removeImage")} onClick={() => setImages((list) => list.filter((_, j) => j !== i))} className="text-text-muted hover:text-text-primary">
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          className={`${inputClass} h-auto min-h-20 resize-none py-2`}
          placeholder={t("chat.placeholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="flex items-center gap-2">
          <select
            aria-label={t("chat.providerLabel")}
            className="h-9 rounded-control border border-border-strong bg-bg-surface px-2 text-body disabled:opacity-60"
            value={provider ?? ""}
            disabled={current.provider !== null || ready.length < 2}
            onChange={(e) => setPicked(e.target.value as Provider)}
          >
            {(current.provider ? [current.provider] : ready).map((p) => (
              <option key={p} value={p}>
                {t(`provider.${p}`)}
              </option>
            ))}
          </select>
          <input ref={fileInput} type="file" accept={IMAGE_TYPES.join(",")} multiple hidden onChange={(e) => void attach(e.target.files).finally(() => (e.target.value = ""))} />
          <Button type="button" variant="ghost" onClick={() => fileInput.current?.click()} disabled={images.length >= MAX_IMAGES}>
            {t("chat.attach")}
          </Button>
          <span className="flex-1" />
          {current.running ? (
            <Button type="button" variant="secondary" onClick={() => void bridge.stop(current.id)}>
              {t("chat.stop")}
            </Button>
          ) : (
            <Button type="submit" disabled={!provider || !draft.trim()}>
              {t("chat.send")}
            </Button>
          )}
        </div>
        <p className="text-meta text-text-muted">{t("chat.memoryOnly")}</p>
      </form>
    </aside>
  );
}

/**
 * The scroll effect. Returns nothing on purpose: Chromium in Electron 44 returns a Promise from scrollIntoView, and
 * React calls whatever an effect returns as its cleanup — passing that Promise through crashed the page.
 */
export function scrollToEnd(el: Pick<Element, "scrollIntoView"> | null): void {
  el?.scrollIntoView({ block: "end" });
}
