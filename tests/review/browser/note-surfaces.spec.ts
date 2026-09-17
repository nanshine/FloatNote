import assert from "node:assert/strict";

const REVIEW_URL = "http://127.0.0.1:1422/tests/review/browser/note-surfaces.html";

interface SurfaceStyle {
  boxShadow: string;
  fontFamily: string;
  fontSize: string;
  height: number;
  lineHeight: string;
  outlineStyle: string;
  padding: string;
}

async function surfaceStyle(selector: string): Promise<SurfaceStyle> {
  return browser.execute((target) => {
    const editor = document.querySelector<HTMLElement>(`${target} .fn-note-structured-editor`);
    const content = editor?.querySelector<HTMLElement>(":scope > .editor");
    if (!editor || !content) throw new Error(`missing note editor: ${target}`);
    const editorStyle = getComputedStyle(editor);
    const contentStyle = getComputedStyle(content);
    return {
      boxShadow: contentStyle.boxShadow,
      fontFamily: editorStyle.fontFamily,
      fontSize: editorStyle.fontSize,
      height: content.getBoundingClientRect().height,
      lineHeight: editorStyle.lineHeight,
      outlineStyle: contentStyle.outlineStyle,
      padding: contentStyle.padding,
    };
  }, selector);
}

describe("note editor surface browser review", () => {
  before(async () => {
    await browser.url(REVIEW_URL);
    await browser.setWindowSize(900, 600);
    await browser.waitUntil(() => browser.execute(() => document.body.dataset.reviewReady === "true"));
  });

  it("fills both empty columns and accepts clicks near their bottom edge", async () => {
    for (const selector of ["#inbox-host", "#piece-host"]) {
      const content = await $(`${selector} .editor`);
      const host = await $(selector);
      const size = await content.getSize();
      const hostSize = await host.getSize();
      assert.ok(size.height > 200, `${selector} editor height is only ${size.height}px`);
      assert.ok(Math.abs(size.height - hostSize.height) <= 1, `${selector} does not fill its host`);
      await content.click({ x: 0, y: Math.floor(size.height / 2) - 8 });
      await browser.waitUntil(() => browser.execute((target) => (
        document.querySelector(target)?.contains(document.activeElement) ?? false
      ), selector));
    }
  });

  it("uses identical typography, spacing and caret-only focus treatment", async () => {
    const inbox = await surfaceStyle("#inbox-host");
    const piece = await surfaceStyle("#piece-host");
    assert.deepEqual(
      { ...inbox, height: 0 },
      { ...piece, height: 0 },
    );
    assert.equal(inbox.outlineStyle, "none");
    assert.equal(inbox.boxShadow, "none");
  });

  it("positions each placeholder inside the empty paragraph line box", async () => {
    const placeholders = await browser.execute(() => ["#inbox-host", "#piece-host"].map((selector) => {
      const paragraph = document.querySelector<HTMLElement>(`${selector} .editor > .fn-empty-paragraph`);
      if (!paragraph) throw new Error(`missing empty paragraph: ${selector}`);
      const paragraphStyle = getComputedStyle(paragraph);
      const placeholderStyle = getComputedStyle(paragraph, "::before");
      return {
        lineHeight: paragraphStyle.lineHeight,
        placeholder: paragraph.dataset.placeholder,
        placeholderLineHeight: placeholderStyle.lineHeight,
        placeholderTop: placeholderStyle.top,
        position: paragraphStyle.position,
      };
    }));
    assert.deepEqual(placeholders, [
      {
        lineHeight: "24px",
        placeholder: "在这里写点什么…",
        placeholderLineHeight: "24px",
        placeholderTop: "0px",
        position: "relative",
      },
      {
        lineHeight: "24px",
        placeholder: "开始写…",
        placeholderLineHeight: "24px",
        placeholderTop: "0px",
        position: "relative",
      },
    ]);
  });

  it("renders horizontal rules with the same semantic color", async () => {
    await browser.url(`${REVIEW_URL}?sample`);
    await browser.waitUntil(() => browser.execute(() => document.body.dataset.reviewReady === "true"));
    const colors = await browser.execute(() => ["#inbox-host", "#piece-host"].map((selector) => {
      const rule = document.querySelector<HTMLElement>(`${selector} hr`);
      if (!rule) throw new Error(`missing divider: ${selector}`);
      return getComputedStyle(rule).backgroundColor;
    }));
    assert.equal(colors[0], colors[1]);
    assert.notEqual(colors[0], "rgba(0, 0, 0, 0)");
  });

  it("selects, edits and deletes first-position special blocks through visible block chrome", async () => {
    await browser.url(`${REVIEW_URL}?special`);
    await browser.setWindowSize(700, 600);
    await browser.waitUntil(() => browser.execute(() => document.body.dataset.reviewReady === "true"));
    const host = "#inbox-host";

    await $(`${host} .fn-quote-card__icon`).click();
    const quoteState = await browser.execute((selector) => {
      const card = document.querySelector<HTMLElement>(`${selector} .fn-quote-card`);
      const editor = card?.querySelector<HTMLElement>(".fn-quote-card__source-editor");
      if (!card || !editor) throw new Error("missing quote card controls");
      return {
        selected: card.classList.contains("is-block-selected"),
        controlsVisible: getComputedStyle(editor).display !== "none",
        controlsFit: editor.scrollWidth <= card.clientWidth,
        borderRadius: getComputedStyle(card).borderRadius,
        outlineOffset: getComputedStyle(card).outlineOffset,
        outlineWidth: getComputedStyle(card).outlineWidth,
      };
    }, host);
    assert.deepEqual(quoteState, {
      selected: true,
      controlsVisible: false,
      controlsFit: true,
      borderRadius: "8px",
      outlineOffset: "-1px",
      outlineWidth: "1px",
    });
    await $(`${host} [aria-label="编辑引用来源"]`).click();
    const sourceName = await $(`${host} [aria-label="引用来源名称"]`);
    await sourceName.click();
    const sourceInputState = await browser.execute((element) => {
      const style = getComputedStyle(element as HTMLElement);
      return { boxShadow: style.boxShadow, caretColor: style.caretColor, color: style.color, outlineStyle: style.outlineStyle };
    }, sourceName);
    assert.equal(sourceInputState.boxShadow, "none");
    assert.equal(sourceInputState.caretColor, sourceInputState.color);
    assert.equal(sourceInputState.outlineStyle, "none");
    await sourceName.setValue("Docs");
    await $(`${host} [aria-label="引用来源链接"]`).setValue("https://docs.example.com");
    await $(`${host} [aria-label="保存引用来源"]`).click();
    await browser.waitUntil(() => browser.execute((selector) => {
      const card = document.querySelector<HTMLElement>(`${selector} .fn-quote-card`);
      return card?.querySelector(".fn-quote-card__source")?.textContent === "Docs"
        && card.querySelector(".fn-quote-card__content")?.textContent?.includes("captured text");
    }, host));
    await $(`${host} .fn-quote-card__icon`).click();
    await browser.keys(["Delete"]);
    await browser.waitUntil(() => browser.execute((selector) => !document.querySelector(`${selector} .fn-quote-card`), host));

    const language = await $(`${host} .fn-structured-codeblock__language`);
    await language.click();
    const languageInputState = await browser.execute((element) => {
      const style = getComputedStyle(element as HTMLElement);
      return {
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
        caretColor: style.caretColor,
        color: style.color,
        height: style.height,
        lineHeight: style.lineHeight,
        outlineStyle: style.outlineStyle,
      };
    }, language);
    assert.equal(languageInputState.borderRadius, "0px");
    assert.equal(languageInputState.boxShadow, "none");
    assert.equal(languageInputState.caretColor, languageInputState.color);
    assert.equal(languageInputState.height, "20px");
    assert.equal(languageInputState.lineHeight, "16px");
    assert.equal(languageInputState.outlineStyle, "none");
    await $(`${host} .fn-structured-codeblock .fn-structured-block-handle`).click();
    assert.equal(await $(`${host} .fn-structured-codeblock`).getAttribute("class").then((value) => value.includes("is-block-selected")), true);
    await browser.keys(["Backspace"]);
    await browser.waitUntil(() => browser.execute((selector) => !document.querySelector(`${selector} .fn-structured-codeblock`), host));

    await $(`${host} .fn-structured-divider`).click();
    assert.equal(await $(`${host} .fn-structured-divider`).getAttribute("aria-label"), "分隔线；点击选择，Delete 或 Backspace 删除");
    assert.ok((await $(`${host} .fn-structured-divider`).getSize("height")) <= 18);
    await browser.keys(["Delete"]);
    await browser.waitUntil(() => browser.execute((selector) => !document.querySelector(`${selector} .fn-structured-divider`), host));
  });

  it("keeps long inbox and piece documents scrollable in their intended scrollports", async () => {
    await browser.url(`${REVIEW_URL}?long`);
    await browser.waitUntil(() => browser.execute(() => document.body.dataset.reviewReady === "true"));
    const overflow = await browser.execute(() => ["#inbox-host", ".surface-piece-scroll"].map((selector) => {
      const scrollport = document.querySelector<HTMLElement>(selector);
      if (!scrollport) throw new Error(`missing scrollport: ${selector}`);
      return scrollport.scrollHeight > scrollport.clientHeight;
    }));
    assert.deepEqual(overflow, [true, true]);
  });

  it("lets the final paragraph scroll to the middle of each writing surface", async () => {
    await browser.url(REVIEW_URL + "?long");
    await browser.waitUntil(() => browser.execute(() => document.body.dataset.reviewReady === "true"));
    const positions = await browser.execute(() => [
      ["#inbox-host", "#inbox-host"],
      [".surface-piece-scroll", "#piece-host"],
    ].map(([scrollSelector, editorSelector]) => {
      const scrollport = document.querySelector<HTMLElement>(scrollSelector);
      const paragraphs = document.querySelectorAll<HTMLElement>(editorSelector + " .editor > p");
      const last = paragraphs.item(paragraphs.length - 1);
      if (!scrollport || !last) throw new Error("missing long document: " + editorSelector);
      scrollport.scrollTop = scrollport.scrollHeight;
      const scrollRect = scrollport.getBoundingClientRect();
      return {
        lastBottom: last.getBoundingClientRect().bottom,
        middle: scrollRect.top + scrollRect.height / 2,
      };
    }));
    for (const position of positions) {
      assert.ok(
        position.lastBottom <= position.middle + 24,
        "final paragraph stops " + Math.round(position.lastBottom - position.middle) + "px below the writing midpoint",
      );
    }
  });

  it("keeps full-width image selection chrome inside the horizontal viewport", async () => {
    await browser.url(REVIEW_URL + "?image");
    await browser.setWindowSize(700, 600);
    await browser.waitUntil(() => browser.execute(() => document.body.dataset.reviewReady === "true"));
    await $("#inbox-host .fn-structured-image__image").click();
    const bounds = await browser.execute(() => {
      const host = document.querySelector<HTMLElement>("#inbox-host");
      const left = host?.querySelector<HTMLElement>(".fn-structured-image__resize--w");
      const right = host?.querySelector<HTMLElement>(".fn-structured-image__resize--e");
      if (!host || !left || !right) throw new Error("missing selected image controls");
      const hostRect = host.getBoundingClientRect();
      return {
        hostLeft: hostRect.left,
        hostRight: hostRect.right,
        left: left.getBoundingClientRect().left,
        right: right.getBoundingClientRect().right,
      };
    });
    assert.ok(bounds.left >= bounds.hostLeft, "left image resize handle is clipped");
    assert.ok(bounds.right <= bounds.hostRight, "right image resize handle is clipped");
  });

  it("keeps list disclosure controls inside the surface with room for multi-digit markers", async () => {
    await browser.url(`${REVIEW_URL}?lists`);
    await browser.waitUntil(() => browser.execute(() => document.body.dataset.reviewReady === "true"));
    const layout = await browser.execute(() => ["#inbox-host", "#piece-host"].map((selector) => {
      const host = document.querySelector<HTMLElement>(selector);
      const list = host?.querySelector<HTMLOListElement>("ol");
      const item = list?.querySelector<HTMLLIElement>("li:has(.fn-list-fold-toggle:not([hidden]))");
      const toggle = item?.querySelector<HTMLElement>(":scope > .fn-list-fold-toggle");
      if (!host || !list || !item || !toggle) throw new Error(`missing list fixture: ${selector}`);
      const hostRect = host.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      const toggleRect = toggle.getBoundingClientRect();
      return {
        indent: itemRect.left - list.getBoundingClientRect().left,
        toggleInside: toggleRect.left >= hostRect.left && toggleRect.right < itemRect.left,
      };
    }));
    for (const surface of layout) {
      assert.ok(surface.indent >= 48, `list gutter is only ${surface.indent}px`);
      assert.equal(surface.toggleInside, true);
    }
  });

});
