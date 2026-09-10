// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectMenuRenderer, fileManagerRevealLabel } from "./project-menu-render";

describe("project menu renderer", () => {
  // promptRename 会把 host 替换为 input 并挂到 body；每个用例后清空，避免
  // 多个用例的 .switch-new-input 残留导致 querySelector 命中陈旧节点。
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("uses the native file-manager name in the reveal action", () => {
    expect(fileManagerRevealLabel("MacIntel")).toBe("在 Finder 中显示");
    expect(fileManagerRevealLabel("Win32")).toBe("在文件资源管理器中显示");
  });

  it("does not submit a rename while an IME confirms text", async () => {
    const closeMenu = vi.fn();
    const renderer = createProjectMenuRenderer({
      closeMenu,
      closeSubmenu: vi.fn(),
      openSubmenu: vi.fn(),
      isSubmenuOpenFor: () => false,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const commit = vi.fn().mockResolvedValue(undefined);
    renderer.promptRename(host, "旧名称", commit);
    const input = document.querySelector<HTMLInputElement>(".switch-new-input")!;
    input.value = "新名称";

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
    expect(commit).not.toHaveBeenCalled();
    expect(closeMenu).not.toHaveBeenCalled();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(commit).toHaveBeenCalledWith("新名称"));
  });

  it("commits the rename when the input blurs with a changed value", async () => {
    const closeMenu = vi.fn();
    const renderer = createProjectMenuRenderer({
      closeMenu,
      closeSubmenu: vi.fn(),
      openSubmenu: vi.fn(),
      isSubmenuOpenFor: () => false,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const commit = vi.fn().mockResolvedValue(undefined);
    renderer.promptRename(host, "旧名称", commit);
    const input = document.querySelector<HTMLInputElement>(".switch-new-input")!;
    input.value = "新名称";

    input.dispatchEvent(new FocusEvent("blur"));
    await vi.waitFor(() => expect(commit).toHaveBeenCalledWith("新名称"));
    expect(closeMenu).toHaveBeenCalled();
  });

  it("closes without committing when the input blurs unchanged", async () => {
    const closeMenu = vi.fn();
    const renderer = createProjectMenuRenderer({
      closeMenu,
      closeSubmenu: vi.fn(),
      openSubmenu: vi.fn(),
      isSubmenuOpenFor: () => false,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const commit = vi.fn().mockResolvedValue(undefined);
    renderer.promptRename(host, "旧名称", commit);
    const input = document.querySelector<HTMLInputElement>(".switch-new-input")!;

    input.dispatchEvent(new FocusEvent("blur"));
    await vi.waitFor(() => expect(closeMenu).toHaveBeenCalled());
    expect(commit).not.toHaveBeenCalled();
  });

  it("cancels on Escape and ignores a blur that follows", () => {
    const closeMenu = vi.fn();
    const renderer = createProjectMenuRenderer({
      closeMenu,
      closeSubmenu: vi.fn(),
      openSubmenu: vi.fn(),
      isSubmenuOpenFor: () => false,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const commit = vi.fn().mockResolvedValue(undefined);
    renderer.promptRename(host, "旧名称", commit);
    const input = document.querySelector<HTMLInputElement>(".switch-new-input")!;
    input.value = "新名称";

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(closeMenu).toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();

    // 菜单关闭移除 input 后触发的 blur 不应再提交。
    input.dispatchEvent(new FocusEvent("blur"));
    expect(commit).not.toHaveBeenCalled();
  });

  it("commits on an outside pointerdown before the menu dismisses the input", async () => {
    const closeMenu = vi.fn();
    const renderer = createProjectMenuRenderer({
      closeMenu,
      closeSubmenu: vi.fn(),
      openSubmenu: vi.fn(),
      isSubmenuOpenFor: () => false,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const commit = vi.fn().mockResolvedValue(undefined);
    renderer.promptRename(host, "旧名称", commit);
    const input = document.querySelector<HTMLInputElement>(".switch-new-input")!;
    input.value = "新名称";

    const outside = document.createElement("div");
    document.body.append(outside);
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await vi.waitFor(() => expect(commit).toHaveBeenCalledWith("新名称"));
  });

  it("opens and closes the section add submenu from its trigger", () => {
    const openSubmenu = vi.fn();
    const closeSubmenu = vi.fn();
    const renderer = createProjectMenuRenderer({
      closeMenu: vi.fn(),
      closeSubmenu,
      openSubmenu,
      isSubmenuOpenFor: () => false,
    });

    const header = renderer.sectionHeader("ph-folder", "项目", {
      ariaLabel: "新建项目",
      onOpen: (trigger) => openSubmenu(trigger, []),
    });
    const add = header.querySelector<HTMLButtonElement>("button")!;
    add.click();

    expect(openSubmenu).toHaveBeenCalledWith(add, []);

    const expandedRenderer = createProjectMenuRenderer({
      closeMenu: vi.fn(),
      closeSubmenu,
      openSubmenu,
      isSubmenuOpenFor: () => true,
    });
    const expandedHeader = expandedRenderer.sectionHeader("ph-folder", "项目", {
      ariaLabel: "新建项目",
      onOpen: vi.fn(),
    });
    const expandedAdd = expandedHeader.querySelector<HTMLButtonElement>("button")!;
    expandedAdd.click();

    expect(closeSubmenu).toHaveBeenCalled();
  });

  it("opens a row and exposes row actions through the kebab submenu", () => {
    const openSubmenu = vi.fn();
    const onOpen = vi.fn();
    const onAction = vi.fn();
    const renderer = createProjectMenuRenderer({
      closeMenu: vi.fn(),
      closeSubmenu: vi.fn(),
      openSubmenu,
      isSubmenuOpenFor: () => false,
    });

    const row = renderer.makeSwitcherRow({
      label: "项目 A",
      onOpen,
      actions: [{ label: "删除", icon: "ph-trash", danger: true, onClick: onAction }],
    });
    row.querySelector<HTMLButtonElement>(".switch-row-label")!.click();
    const kebab = row.querySelector<HTMLButtonElement>(".switch-row-kebab")!;
    kebab.click();

    expect(onOpen).toHaveBeenCalledOnce();
    expect(openSubmenu).toHaveBeenCalledOnce();
    const items = openSubmenu.mock.calls[0][1] as HTMLElement[];
    expect(items[0].classList.contains("danger")).toBe(true);
    items[0].click();
    expect(onAction).toHaveBeenCalledWith(row);
  });
});
