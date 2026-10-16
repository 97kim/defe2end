import { describe, expect, it } from "vitest";
import { captureA11ySnapshot, dropInputValues, redactNumbers } from "./a11y-snapshot.js";
import { forceMask } from "./masking.js";
import { launchBrowser } from "./browser.js";
import { SANDBOX } from "./test-support.js";

const PAGE = `
  <h1>Shop</h1>
  <p id="acct">Account 4242-SECRET-TOKEN</p>
  <button aria-describedby="acct">Pay</button>
  <label for="mail">Mail</label><input id="mail" value="typed@example.com">
  <div class="private" id="who">Mina Park</div>
  <button aria-labelledby="who">Profile</button>
  <label>Card <input class="private" value="1"></label>
  <a href="https://shop.example/home?token=abc">Home</a>
  <p>Call 010-1234-5678 or write to mina@example.com</p>
  <div id="host"></div>
  <script>
    const root = document.getElementById("host").attachShadow({ mode: "open" });
    root.innerHTML = '<p class="private">shadow secret</p><p>shadow open</p>';
  </script>`;

async function withPage<T>(html: string, fn: (page: import("playwright").Page) => Promise<T>): Promise<T> {
  const running = await launchBrowser({ owner: String(process.pid), runId: "a11y-snapshot", sandbox: SANDBOX, hostRules: "" });
  try {
    const page = await running.browser.newPage();
    await page.setContent(html);
    return await fn(page);
  } finally {
    await running.close();
  }
}

describe("captureA11ySnapshot", () => {
  it("hides masked nodes and what names them, drops input values, masks secrets and personal data, then restores", async () => {
    await withPage(PAGE, async (page) => {
      const before = await page.locator("body").ariaSnapshot();
      const result = await captureA11ySnapshot(page, { selectors: [".private", "#acct"], secrets: ["4242-SECRET-TOKEN"] });
      expect(result.ok).toBe(true);
      const text = (result as { text: string }).text;
      expect(text).toContain('heading "Shop"');
      expect(text).toContain("shadow open");
      for (const leaked of ["Mina Park", "Profile", "shadow secret", "4242-SECRET-TOKEN", "Pay", "typed@example.com", "010-1234-5678", "mina@example.com", "token=abc", "Card"]) {
        expect(text).not.toContain(leaked);
      }
      // Put back exactly as it was.
      expect(await page.locator("body").ariaSnapshot()).toBe(before);
      expect(await page.locator("[data-defe2end-a11y-hidden]").count()).toBe(0);
    });
  });

  it("an invalid selector or an exhausted budget is a masking failure, and the page is restored", async () => {
    await withPage(PAGE, async (page) => {
      const bad = await captureA11ySnapshot(page, { selectors: ["::nope("], secrets: [] });
      expect(bad.ok).toBe(false);
      const slow = await captureA11ySnapshot(page, { selectors: [".private"], secrets: [], budgetMs: 0 });
      expect(slow.ok).toBe(false);
      expect(await page.locator("[aria-hidden]").count()).toBe(0);
    });
  });

  it("drops values after input roles but keeps their names", () => {
    expect(dropInputValues('- textbox "Email": mina@example.com\n- button "Go"\n- combobox "Size":\n  - option "M"')).toBe('- textbox "Email"\n- button "Go"\n- combobox "Size":\n  - option "M"');
  });

  it("hides what the page's masking marked (automatic detection) and the card fields, like the screenshot", async () => {
    const html = `<h1>Order</h1><p>Card 4111 1111 1111 1111</p><p>ID 900101-1234567</p><p>Owner kim@example.org</p>
      <label for="cc">Card number</label><input id="cc" autocomplete="cc-number" value="4111111111111111"><p>Total 12,000</p>`;
    await withPage(html, async (page) => {
      expect(await forceMask(page, { enabled: true, selectors: [], policyVersion: 1 })).toBeNull();
      const result = await captureA11ySnapshot(page, { selectors: [], secrets: [] });
      const text = (result as { text: string }).text;
      expect(result.ok).toBe(true);
      // Whole marked nodes leave the tree ("Owner" too), not just the matched text.
      for (const leaked of ["4111", "900101", "1234567", "kim@example.org", "Card number", "Owner"]) expect(text).not.toContain(leaked);
      expect(text).toContain("Total 12,000");
    });
  });

  it("masks card and resident numbers left in the text, not short numbers", () => {
    expect(redactNumbers("pay 4111-1111-1111-1111 id 900101-1234567 on 2026-10-16 for 12000")).toBe("pay [number] id [number] on 2026-10-16 for 12000");
  });
});
