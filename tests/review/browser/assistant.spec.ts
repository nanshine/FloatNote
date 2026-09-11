import assert from "node:assert/strict";

interface InputChrome {
  bottomOffset: number;
  backgroundColor: string;
  borderColor: string;
  borderRadius: string;
  borderStyle: string;
  boxShadow: string;
  height: number;
  opacity: string;
  width: number;
}

async function inputChrome(): Promise<InputChrome> {
  return browser.execute(() => {
    const editor = document.querySelector<HTMLElement>(".fn-assistant-structured-editor");
    if (!editor) throw new Error("assistant editor is missing");
    const style = getComputedStyle(editor);
    const rect = editor.getBoundingClientRect();
    return {
      bottomOffset: rect.bottom - document.querySelector(".assistant-send")!.getBoundingClientRect().bottom,
      backgroundColor: style.backgroundColor,
      borderColor: style.borderTopColor,
      borderRadius: style.borderRadius,
      borderStyle: style.borderTopStyle,
      boxShadow: style.boxShadow,
      height: rect.height,
      opacity: style.opacity,
      width: rect.width,
    };
  });
}

function assertVisibleChrome(chrome: InputChrome) {
  assert.ok(Math.abs(chrome.bottomOffset) <= 1, `input bottom is displaced by ${chrome.bottomOffset}px`);
  assert.equal(chrome.borderStyle, "solid");
  assert.equal(chrome.borderRadius, "18px");
  assert.notEqual(chrome.backgroundColor, "rgba(0, 0, 0, 0)");
  assert.equal(chrome.opacity, "1");
  assert.ok(chrome.width >= 180, `input width is only ${chrome.width}px`);
  assert.ok(chrome.height >= 36, `input height is only ${chrome.height}px`);
  assert.ok(chrome.height <= 40, `compact input grew to ${chrome.height}px`);
}

describe("assistant input browser review", () => {
  before(async () => {
    const stage = await $("#review-stage");
    await stage.waitForExist();
  });

  it("keeps rounded chrome across focus, blur, close and reopen", async () => {
    const bot = await $(".assistant-bot");
    const wrap = await $(".assistant-input-wrap");
    const editor = await $(".fn-assistant-structured-editor");
    await editor.waitForExist();
    const content = await $(".fn-assistant-structured-editor .editor");

    await bot.click();
    await browser.waitUntil(() => wrap.getAttribute("class").then((value) => value.includes("open")));
    assertVisibleChrome(await inputChrome());

    await content.click();
    await browser.waitUntil(() => browser.execute(() => (
      document.querySelector(".fn-assistant-structured-editor")?.contains(document.activeElement) ?? false
    )));
    await content.setValue("你好");
    const focused = await inputChrome();
    assertVisibleChrome(focused);
    assert.equal(focused.boxShadow, "none");
    assert.equal(focused.borderColor, "rgb(79, 70, 229)");

    await browser.keys("Tab");
    await browser.waitUntil(() => browser.execute(() => !(
      document.querySelector(".fn-assistant-structured-editor")?.contains(document.activeElement) ?? false
    )));
    assertVisibleChrome(await inputChrome());

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await bot.click();
      await browser.waitUntil(() => wrap.getAttribute("class").then((value) => !value.includes("open")));
      await bot.click();
      await browser.waitUntil(() => browser.execute(() => {
        const wrap = document.querySelector(".assistant-input-wrap")!;
        return wrap.classList.contains("open") && wrap.getAnimations().length === 0
          && Boolean(document.querySelector(".editor")?.contains(document.activeElement));
      }));
      assertVisibleChrome(await inputChrome());
      assert.equal(await content.getText(), "你好");
    }
  });
});

describe("permission review responsiveness", () => {
  it("uses unified rows in a narrow paper and two columns in a wide paper", async () => {
    await browser.setWindowSize(620, 600);
    await browser.execute(() => {
      const open = (window as typeof window & { openPermissionReview?: () => void }).openPermissionReview;
      if (!open) throw new Error("permission review fixture is missing");
      open();
    });
    await $(".perm-dialog:not([hidden])").waitForDisplayed();

    const narrow = await browser.execute(() => {
      const dialog = document.querySelector<HTMLElement>(".perm-dialog:not([hidden])")!;
      const unified = dialog.querySelector<HTMLElement>(".perm-diff-unified")!;
      const wide = dialog.querySelector<HTMLElement>(".perm-diff-wide")!;
      const scroll = dialog.querySelector<HTMLElement>(".perm-diff-scroll")!;
      return {
        unified: getComputedStyle(unified).display,
        wide: getComputedStyle(wide).display,
        fits: scroll.scrollWidth <= scroll.clientWidth + 1,
      };
    });
    assert.deepEqual(narrow, { unified: "block", wide: "none", fits: true });

    await browser.setWindowSize(900, 600);
    await browser.waitUntil(async () => {
      const displays = await browser.execute(() => {
        const dialog = document.querySelector<HTMLElement>(".perm-dialog:not([hidden])")!;
        return {
          unified: getComputedStyle(dialog.querySelector<HTMLElement>(".perm-diff-unified")!).display,
          wide: getComputedStyle(dialog.querySelector<HTMLElement>(".perm-diff-wide")!).display,
        };
      });
      return displays.unified === "none" && displays.wide === "grid";
    });
  });

  it("loads KaTeX fonts and contains a wide formula in the rendered preview", async () => {
    await browser.setWindowSize(420, 600);
    await browser.execute(() => {
      const open = (window as typeof window & { openPermissionReview?: () => void }).openPermissionReview;
      if (!open) throw new Error("permission review fixture is missing");
      open();
    });
    await $(".perm-dialog:not([hidden])").waitForDisplayed();
    const previewTab = await $(".perm-review-tab:last-child");
    await previewTab.click();
    await $(".perm-dialog-markdown .katex-display").waitForDisplayed();

    const result = await browser.execute(async () => {
      await document.fonts.ready;
      const article = document.querySelector<HTMLElement>(".perm-dialog-markdown")!;
      const inline = article.querySelector<HTMLElement>(".katex")!;
      const display = article.querySelector<HTMLElement>(".katex-display")!;
      return {
        fontFamily: getComputedStyle(inline).fontFamily,
        articleFits: article.scrollWidth <= article.clientWidth + 1,
        formulaScrolls: display.scrollWidth > display.clientWidth,
      };
    });

    assert.match(result.fontFamily, /KaTeX_Main/);
    assert.equal(result.articleFits, true);
    assert.equal(result.formulaScrolls, true);
  });
});
