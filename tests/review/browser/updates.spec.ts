import assert from "node:assert/strict";

describe("application update UI", () => {
  for (const theme of ["light", "dark"]) {
    it(`shows release notes and download progress in ${theme} theme`, async () => {
      await browser.setWindowSize(780, 620);
      await browser.url(`http://127.0.0.1:1422/tests/review/browser/updates.html?theme=${theme}`);
      await browser.waitUntil(() => browser.execute(() => document.body.dataset.reviewReady === "true"));
      assert.match(await $("[data-update-status]").getText(), /0.2.0/);
      assert.equal(await $("[data-update-notes]").isDisplayed(), true);
      assert.equal(await $("[data-update-notes] h2").getText(), "新功能");
      assert.equal(await $("[data-update-notes] strong").getText(), "应用内更新");
      assert.equal(await $("[data-update-notes] pre code").getText(), "FloatNote 更新完成");
      await browser.saveScreenshot(`artifacts/browser-review/updates-${theme}.png`);
      await $("[data-update-install]").click();
      await browser.waitUntil(async () => (await $("[data-update-status]").getText()).includes("正在下载"));
      assert.equal(await $("[data-update-check]").isEnabled(), false);
      assert.equal(await $("progress").getAttribute("value"), "40");
    });

    it(`shows a recoverable feed error in ${theme} theme`, async () => {
      await browser.setWindowSize(780, 620);
      await browser.url(`http://127.0.0.1:1422/tests/review/browser/updates.html?theme=${theme}&state=error`);
      await browser.waitUntil(() => browser.execute(() => document.body.dataset.reviewReady === "true"));
      assert.equal(await $("[data-update-error-title]").getText(), "无法读取更新信息");
      assert.match(await $("[data-update-error-message]").getText(), /稍后重试/);
      assert.equal(await $("[data-update-retry]").isDisplayed(), true);
      await browser.saveScreenshot(`artifacts/browser-review/updates-error-${theme}.png`);
    });
  }
});
