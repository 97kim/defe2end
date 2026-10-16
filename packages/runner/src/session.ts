// Per-run browser state the actions share: which page is current, popups, dialogs, collected responses and
// the fields that hold secrets. Everything here hangs off one browser context, so it covers every page,
// frame and popup of the run.
import type { BrowserContext, Dialog, ElementHandle, Page } from "playwright";

/** One response seen by a collector, in arrival order. */
export interface ResponseEntry {
  url: string;
  method: string;
  status: number;
}

/** Responses one page (its frames included) received while an `assertResponse` step waits. */
export class ResponseLog {
  readonly entries: ResponseEntry[] = [];
  private readonly listeners: (() => void)[] = [];

  constructor(page: Page) {
    const onResponse = (response: import("playwright").Response) => {
      this.entries.push({ url: response.url(), method: response.request().method(), status: response.status() });
    };
    page.on("response", onResponse);
    this.listeners.push(() => page.off("response", onResponse));
  }

  stop(): void {
    for (const off of this.listeners.splice(0)) off();
  }
}

/** A dialog step's own handler (spec 2.8); set while the step runs. */
export type DialogHandler = (dialog: Dialog) => Promise<void>;

export class RunSession {
  /** The first page: every action except popup actions, `wait` and `screenshot` runs here (spec 2.7). */
  readonly mainPage: Page;
  /** The current new window, set by `clickAndWaitPopup` and cleared by `closePopup`. */
  popup: Page | undefined;
  /** Index of the step running now. */
  currentIndex = -1;
  /** Pages opened in this context, with the step during which they opened. */
  readonly opened: { page: Page; stepIndex: number }[] = [];
  /** Elements that were given a secret, per page; screenshots of that page mask them. */
  readonly secretFields: { page: Page; handle: ElementHandle }[] = [];
  /** Pages where a secret went somewhere we can't point at (e.g. typed without a target): no screenshots. */
  readonly unmaskable = new Map<Page, string>();
  /** A dialog step's own handler; while unset the first page's dialogs are accepted. */
  dialogHandler: DialogHandler | undefined;
  /** The page last brought to the front: `wait` and `screenshot` use it. */
  active: Page;

  constructor(
    readonly context: BrowserContext,
    mainPage: Page,
  ) {
    this.mainPage = mainPage;
    this.active = mainPage;
    context.on("page", (page) => {
      this.opened.push({ page, stepIndex: this.currentIndex });
      this.active = page;
      page.on("close", () => {
        if (this.active === page) this.active = this.popup && !this.popup.isClosed() ? this.popup : this.mainPage;
      });
    });
    // Popups have no handler, so Playwright dismisses their dialogs; the first page accepts by default.
    mainPage.on("dialog", (dialog) => {
      const handler = this.dialogHandler;
      void (handler ? handler(dialog) : dialog.accept()).catch(() => {});
    });
  }

  /** Back to the first page as the page in front (an action ran there). */
  get page(): Page {
    return this.mainPage;
  }
}
