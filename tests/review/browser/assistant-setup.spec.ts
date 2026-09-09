import assert from "node:assert/strict";

const URL = "http://127.0.0.1:1422/tests/review/browser/assistant.html";

describe("assistant setup card", () => {
  for (const theme of ["light", "dark"]) {
    it(`preserves a draft after dismissing setup in ${theme} mode`, async () => {
      await browser.setWindowSize(380, 560);
      await browser.url(`${URL}?setup=disabled&theme=${theme}`);
      await browser.waitUntil(() => browser.execute(() => document.body.dataset.reviewReady === "true"));
      await $("button=前往启用").waitForDisplayed();
      await $("button=前往启用").click();
      assert.equal(await browser.execute(() => document.body.dataset.settingsTarget), "ai");
      await $('[aria-label="关闭配置提示"]').click();
      assert.equal(await $(".assistant-setup").isExisting(), false);
      const editor = $(".fn-assistant-structured-editor");
      await editor.click();
      await browser.keys("保留这段草稿");
      await $('[aria-label="发送"]').click();
      await $(".assistant-setup").waitForDisplayed();
      assert.ok((await $(".assistant-setup").getText()).includes("内容已保留"));
      assert.ok((await editor.getText()).includes("保留这段草稿"));
      assert.equal(await $(".chat-block-error").isExisting(), false);
      const bounds = await browser.execute(() => {
        const rect = document.querySelector(".assistant-setup")!.getBoundingClientRect();
        const scroll = document.querySelector(".assistant-scroll")!.getBoundingClientRect();
        return { scrollTop: scroll.top, scrollBottom: scroll.bottom, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight };
      });
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= 0 && bounds.bottom <= bounds.height);
      assert.ok(bounds.top >= bounds.scrollTop - 1 && bounds.bottom <= bounds.scrollBottom + 1);
      await browser.saveScreenshot(`artifacts/browser-review/assistant-setup-${theme}.png`);
    });
  }
});
