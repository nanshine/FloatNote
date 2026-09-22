import {
  replayOnboardingState,
  setOnboardingPreview,
  setOnboardingState,
  type OnboardingPreviewScene,
} from "../platform/onboarding";

const SCENES = ([
  ["welcome", "欢迎"], ["capture-permission", "采集未授权"], ["capture-ready", "采集已准备"],
  ["capture-success", "采集成功"], ["writing", "写作"], ["tasks-closed", "行动关闭"],
  ["tasks-open", "行动打开"], ["split-narrow", "双栏窄窗"], ["split-wide", "双栏宽窗"],
  ["assistant-unconfigured", "AI 未配置"], ["assistant-configured-empty", "AI 已配置空对话"], ["access", "打开与收起"],
] as const).map(([value, label]) => ({ value: value as OnboardingPreviewScene, label }));

export function mountOnboardingSettings(root: HTMLElement, debug: boolean): void {
  root.innerHTML = `<div class="settings-card">
    <div class="settings-line"><div><strong>新手引导</strong><small>从当前项目重新了解采集、写作、行动、双栏、AI 助手与窗口快捷键</small></div><button class="settings-text-button" data-action="restart" type="button">重新开始</button></div>
    <p class="settings-inline-error" role="alert"></p>
  </div>${debug ? `<div class="onboarding-lab"><div class="settings-heading"><h2>Onboarding Lab</h2></div><div class="settings-card"><div class="settings-line"><label for="onboarding-scene"><strong>预览场景</strong><small>模拟状态只保存在本次 debug 运行的内存中</small></label><span class="select-wrap"><select id="onboarding-scene" class="fn-control">${SCENES.map((scene) => `<option value="${scene.value}">${scene.label}</option>`).join("")}</select></span></div><div class="settings-line onboarding-lab-actions"><button class="settings-text-button" data-action="preview" type="button">预览这一步</button><button class="settings-text-button" data-action="stop" type="button">停止预览</button><button class="settings-text-button" data-action="reset" type="button">重置引导进度</button></div></div></div>` : ""}`;
  const error = root.querySelector<HTMLElement>(".settings-inline-error");
  const run = async (action: () => Promise<unknown>) => {
    if (error) error.textContent = "";
    try { await action(); } catch (reason) { if (error) error.textContent = String(reason); }
  };
  root.querySelector<HTMLButtonElement>('[data-action="restart"]')!.onclick = () => void run(() => setOnboardingState(replayOnboardingState()));
  if (!debug) return;
  const select = root.querySelector<HTMLSelectElement>("#onboarding-scene")!;
  root.querySelector<HTMLButtonElement>('[data-action="preview"]')!.onclick = () => void run(() => setOnboardingPreview(select.value as OnboardingPreviewScene));
  root.querySelector<HTMLButtonElement>('[data-action="stop"]')!.onclick = () => void run(() => setOnboardingPreview(null));
  root.querySelector<HTMLButtonElement>('[data-action="reset"]')!.onclick = () => void run(async () => { await setOnboardingPreview(null); await setOnboardingState(replayOnboardingState()); });
}
