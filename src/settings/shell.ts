import { createIcon } from "../shared/ui/icon";

export function settingsShellMarkup(): string {
  return `<main class="settings-window">
    <header class="settings-titlebar"><div class="titlebar-drag" data-tauri-drag-region></div></header>
    <div class="settings-shell">
      <nav class="settings-nav" aria-label="设置分类">
        <button class="settings-tab is-active" data-tab="general" aria-current="page">${createIcon({ phosphor: "ph ph-sliders-horizontal" }).outerHTML}<span>通用</span></button>
        <button class="settings-tab" data-tab="ai">${createIcon({ phosphor: "ph ph-sparkle" }).outerHTML}<span>AI</span></button>
        <button class="settings-tab" data-tab="shortcuts">${createIcon({ phosphor: "ph ph-keyboard" }).outerHTML}<span>快捷键</span></button>
      </nav>
      <section class="settings-content" aria-live="polite">
        <div class="settings-pane" data-pane="general">
          <header class="settings-page-heading"><span>FloatNote</span><h1>通用设置</h1><p>调整 FloatNote 的外观与启动行为。</p></header>
          <section class="settings-section" aria-labelledby="general-title"><h2 id="general-title">通用</h2><div id="general-settings"></div></section>
          <section class="settings-section" aria-label="应用更新"><div id="update-settings"></div></section>
          <section class="settings-section" aria-label="新手引导"><div id="onboarding-settings"></div></section>
        </div>
        <div class="settings-pane" data-pane="ai" hidden>
          <header class="settings-page-heading"><span>FloatNote</span><h1>AI</h1><p>连接你的 AI 模型，决定助手如何回复。</p></header>
          <section class="settings-section" aria-labelledby="providers-title"><h2 id="providers-title">模型服务</h2><div id="provider-settings"></div></section>
          <section class="settings-section" aria-labelledby="output-mode-title"><h2 id="output-mode-title">回复展示</h2><div id="output-mode-settings"></div></section>
          <section class="settings-section" aria-labelledby="skills-title"><div class="settings-heading"><h2 id="skills-title">AI 技能</h2><button id="import-skill" class="settings-text-button" type="button">${createIcon({ phosphor: "ph ph-folder-open" }).outerHTML}<span>导入技能</span></button></div><div id="skills" class="skills-list"><span class="settings-muted">正在读取…</span></div><p id="skills-notice" class="settings-notice" role="status"></p></section>
        </div>
        <div class="settings-pane" data-pane="shortcuts" hidden>
          <header class="settings-page-heading"><span>FloatNote</span><h1>快捷键</h1><p>设置你常用的键盘操作。</p></header>
          <div id="shortcut-settings"></div>
        </div>
        <section id="settings-error" class="settings-blocking-error" role="alert" hidden></section>
      </section>
    </div>
  </main>`;
}

export function mountTabs(root: HTMLElement): (name: string) => void {
  const tabs = root.querySelectorAll<HTMLButtonElement>(".settings-tab");
  const panes = root.querySelectorAll<HTMLElement>(".settings-pane");
  const activate = (name: string) => {
    const tab = [...tabs].find((candidate) => candidate.dataset.tab === name);
    if (!tab) return;
      tabs.forEach((candidate) => {
        const active = candidate === tab;
        candidate.classList.toggle("is-active", active);
        active ? candidate.setAttribute("aria-current", "page") : candidate.removeAttribute("aria-current");
      });
      panes.forEach((pane) => { pane.hidden = pane.dataset.pane !== tab.dataset.tab; });
  };
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => activate(tab.dataset.tab ?? "general"));
  });
  return activate;
}
