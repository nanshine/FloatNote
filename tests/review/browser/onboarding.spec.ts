import assert from "node:assert/strict";

const URL = "http://127.0.0.1:1422/tests/review/browser/onboarding.html";

describe("onboarding browser review", () => {
  for (const width of [380, 840]) {
    for (const theme of ["light", "dark"]) {
      it(`keeps capture guidance usable at ${width}px in ${theme} mode`, async () => {
        await browser.setWindowSize(width, 520);
        await browser.url(`${URL}?scene=capture&theme=${theme}`);
        await browser.waitUntil(() => browser.execute(() => document.body.dataset.reviewReady === "true"));
        const layout = await browser.execute(() => {
          const card = document.querySelector<HTMLElement>(".onboarding-content-card")!;
          const rect = card.getBoundingClientRect();
          const style = getComputedStyle(card);
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, background: style.backgroundColor, overflow: document.documentElement.scrollWidth > innerWidth };
        });
        assert.ok(layout.left >= 0 && layout.right <= layout.viewportWidth);
        assert.ok(layout.top >= 0 && layout.bottom <= layout.viewportHeight);
        assert.equal(layout.overflow, false);
        assert.notEqual(layout.background, "rgba(0, 0, 0, 0)");
      });
    }
  }

  for (const scene of ["writing", "tasks", "split", "assistant"]) {
    it(`clamps the ${scene} coach mark to the viewport`, async () => {
      await browser.setWindowSize(380, 520);
      await browser.url(`${URL}?scene=${scene}`);
      await browser.waitUntil(() => browser.execute(() => document.body.dataset.reviewReady === "true"));
      const rect = await browser.execute(() => {
        const value = document.querySelector<HTMLElement>(".onboarding-coach")!.getBoundingClientRect();
        return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: innerWidth, height: innerHeight };
      });
      assert.ok(rect.left >= 8 && rect.right <= rect.width - 8);
      assert.ok(rect.top >= 8 && rect.bottom <= rect.height - 8);
    });
  }

  it("shows result cards after opening tasks, split and AI", async () => {
    await browser.setWindowSize(840, 520);
    await browser.url(`${URL}?scene=tasks`);
    await browser.waitUntil(() => browser.execute(() => document.body.dataset.reviewReady === "true"));
    await $("button=打开行动清单").click();
    await browser.waitUntil(async () => (await $("#onboarding-root h2").getText()) === "行动清单已打开");
    assert.equal(await $("button=打开行动清单").isExisting(), false);
    const layout = await browser.execute(() => {
      const panel = document.querySelector(".tasks-panel")!.getBoundingClientRect();
      const card = document.querySelector(".onboarding-coach")!.getBoundingClientRect();
      return { overlap: card.left < panel.right && card.right > panel.left && card.top < panel.bottom && card.bottom > panel.top, panelVisible: panel.top >= 0 && panel.bottom <= innerHeight && panel.left >= 0 && panel.right <= innerWidth };
    });
    assert.equal(layout.overlap, false);
    assert.equal(layout.panelVisible, true);
    await browser.saveScreenshot("artifacts/browser-review/onboarding-tasks-open.png");
    await $("button=下一步").click();
    await $("button=进入双栏").click();
    await browser.waitUntil(async () => (await $("#onboarding-root h2").getText()) === "现在可以边看边写");
    await $("button=下一步").click();
    await $("button=打开 AI 助手").click();
    await browser.waitUntil(async () => (await $("#onboarding-root h2").getText()) === "认识苏格拉底 AI");
    await $("button=完成引导").click();
    await browser.waitUntil(() => browser.execute(() => document.body.dataset.onboardingStatus === "completed"));
  });

  for (const scene of ["welcome", "capture", "capture-success", "capture-permission"]) {
    it(`reviews the real ${scene} card at narrow width`, async () => {
      await browser.setWindowSize(380, 520);
      await browser.url(`${URL}?scene=${scene}`);
      await browser.waitUntil(() => browser.execute(() => document.body.dataset.reviewReady === "true"));
      await browser.saveScreenshot(`artifacts/browser-review/onboarding-${scene}.png`);
      assert.equal(await browser.execute(() => document.documentElement.scrollWidth > innerWidth), false);
    });
  }

});
