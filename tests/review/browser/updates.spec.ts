import assert from "node:assert/strict";

describe("application update UI", () => {
  for (const theme of ["light", "dark"]) {
    it(`shows release notes and download progress in ${theme} theme`, async () => {
      await browser.setWindowSize(780, 620);
      await browser.url(`http://127.0.0.1:1422/tests/review/browser/updates.html?theme=${theme}`);
      await browser.waitUntil(() => browser.execute(() => document.body.dataset.reviewReady === "true"));
      assert.match(await $("[data-update-status]").getText(), /0.2.0/);
      assert.equal(await $("[data-update-notes]").isDisplayed(), true);
      await browser.saveScreenshot(`artifacts/browser-review/updates-${theme}.png`);
      await $("[data-update-install]").click();
      await browser.waitUntil(async () => (await $("[data-update-status]").getText()).includes("正在下载"));
      assert.equal(await $("[data-update-check]").isEnabled(), false);
      assert.equal(await $("progress").getAttribute("value"), "40");
    });
  }
});
