import { describe, expect, it } from "vitest";
import { isLabelLikeDataValue, REDACTED, redactDom, redactText, redactUrl, SECRET_MASK } from "./index.js";

const M = SECRET_MASK;

describe("redactUrl", () => {
  it("keeps path, hides query values but keeps key names", () => {
    expect(redactUrl("https://shop.test/orders/1?token=abc&page=2")).toBe(`https://shop.test/orders/1?token=${M}&page=${M}`);
  });

  it("hides bare query parts, keeps empty values and works on relative URLs", () => {
    expect(redactUrl("/search?abc123&q=&x=1")).toBe(`/search?${M}&q=&x=${M}`);
  });

  it("hides parameter-like fragments and credentials, keeps plain anchors", () => {
    expect(redactUrl("https://a.test/cb#access_token=xyz&state=1")).toBe(`https://a.test/cb#access_token=${M}&state=${M}`);
    expect(redactUrl("https://a.test/doc#section-2")).toBe("https://a.test/doc#section-2");
    expect(redactUrl("https://user:pw@a.test/x")).toBe(`https://${M}@a.test/x`);
  });

  it("leaves URLs without query untouched", () => {
    expect(redactUrl("https://a.test/a/b")).toBe("https://a.test/a/b");
  });
});

describe("redactText", () => {
  it("hides secret values", () => {
    expect(redactText("login with hunter2 failed", { secrets: ["hunter2"] })).toBe(`login with ${M} failed`);
  });

  it("hides URL queries in text and keeps trailing punctuation", () => {
    expect(redactText("Navigated to https://a.test/p?id=42. Then (see http://b.test/?q=x).")).toBe(
      `Navigated to https://a.test/p?id=${M}. Then (see http://b.test/?q=${M}).`,
    );
  });

  it("hides emails", () => {
    expect(redactText("user kim.min-su+test@example.co.kr signed in")).toBe(`user ${REDACTED.email} signed in`);
  });

  it("hides phone numbers in common shapes", () => {
    for (const phone of ["010-1234-5678", "01012345678", "02-123-4567", "+82 10 1234 5678", "+1 415 555 1234", "(415) 555-1234", "010.1234.5678"]) {
      expect(redactText(`call ${phone} now`)).toBe(`call ${REDACTED.phone} now`);
    }
  });

  it("does not mistake dates, times, prices or ids for phone numbers", () => {
    const text = "2026-10-15 10:30:00 took 12345 ms, price 1,234,567, order 20261015123, v1.2.3";
    expect(redactText(text)).toBe(text);
  });

  it("returns plain text unchanged", () => {
    expect(redactText("Element not found: button.submit")).toBe("Element not found: button.submit");
  });
});

describe("isLabelLikeDataValue", () => {
  it("keeps labels and rejects values", () => {
    for (const v of ["", "open", "primary-button", "step_2", "nav:main"]) expect(isLabelLikeDataValue(v)).toBe(true);
    for (const v of ["12345", "user-12345", "Kim Minsu", '{"a":1}', "a@b.test", "https://a.test", "x".repeat(70)]) expect(isLabelLikeDataValue(v)).toBe(false);
  });
});

describe("redactDom", () => {
  it("drops input/select/textarea values and textarea content", () => {
    expect(redactDom('<input name="q" value="hello"><select value="x"></select><textarea name="memo">my note</textarea>')).toBe(
      '<input name="q"><select></select><textarea name="memo"></textarea>',
    );
  });

  it("keeps option values (page-authored) and button values", () => {
    expect(redactDom('<option value="kr">Korea</option><button value="go">Go</button>')).toBe('<option value="kr">Korea</option><button value="go">Go</button>');
  });

  it("empties sensitive selects and handles password and card fields", () => {
    expect(redactDom('<input type="password" value="pw"><input autocomplete="cc-number" value="4111"><select autocomplete="billing cc-exp-month"><option>12</option></select>')).toBe(
      '<input type="password"><input autocomplete="cc-number"><select autocomplete="billing cc-exp-month"></select>',
    );
    expect(redactDom("<textarea autocomplete=one-time-code>123456</textarea>")).toBe('<textarea autocomplete="one-time-code"></textarea>');
  });

  it("masks data-* values that look like values and keeps labels and test hooks", () => {
    expect(redactDom('<div data-state="open" data-user-id="98765" data-name="Kim Minsu" data-testid="row-12345" data-json=\'{"a":1}\'>x</div>')).toBe(
      `<div data-state="open" data-user-id="${M}" data-name="${M}" data-testid="row-12345" data-json="${M}">x</div>`,
    );
  });

  it("hides query values in URL attributes, relative ones too", () => {
    expect(redactDom('<a href="/orders?id=7">o</a><img src="https://cdn.test/a.png?sig=abc" />')).toBe(`<a href="/orders?id=${M}">o</a><img src="https://cdn.test/a.png?sig=${M}" />`);
  });

  it("redacts text nodes and other attribute values", () => {
    expect(redactDom('<p title="mail me@a.test">Call 010-1234-5678 or me@a.test</p>')).toBe(`<p title="mail ${REDACTED.email}">Call ${REDACTED.phone} or ${REDACTED.email}</p>`);
  });

  it("masks secrets, also in HTML-escaped form", () => {
    expect(redactDom('<p data-x="ok">token a&b"c</p><span>a&amp;b&quot;c</span>', { secrets: ['a&b"c'] })).toBe(`<p data-x="ok">token ${M}</p><span>${M}</span>`);
  });

  it("drops comments and script/style content", () => {
    expect(redactDom('<!-- user 42 --><script>window.__STATE__={"token":"x"}</script><style>.a{}</style><b>hi</b>')).toBe("<script></script><style></style><b>hi</b>");
  });

  it("handles quoted > in attributes, uppercase tags and unquoted values", () => {
    expect(redactDom('<INPUT VALUE="v" title="a > b" type=text>')).toBe('<INPUT title="a > b" type="text">');
  });

  it("treats a stray < as text and survives an unclosed textarea", () => {
    expect(redactDom("1 < 2 and <textarea>secret")).toBe("1 < 2 and <textarea>");
  });

  it("re-escapes double quotes from single-quoted values", () => {
    expect(redactDom(`<span title='say "hi"'>x</span>`)).toBe('<span title="say &quot;hi&quot;">x</span>');
  });

  it("keeps boolean attributes", () => {
    expect(redactDom('<input disabled required name="a">')).toBe('<input disabled required name="a">');
  });

  it("stays fast on long runs with nothing to hide", () => {
    const start = performance.now();
    redactText("x".repeat(200_000));
    redactText("1".repeat(200_000));
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});
