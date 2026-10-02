/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenderDestinationFields } from "@/transfer/render/components/RenderDestinationFields";

vi.mock("@/components/ui", () => ({
  Button: ({ children, onPress, isDisabled }: {
    children: ReactNode;
    onPress?: () => void;
    isDisabled?: boolean;
  }) => createElement("button", { disabled: isDisabled, onClick: onPress }, children),
}));

describe("audio render destination fields", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onChange = vi.fn<(value: string) => void>();
  const onBrowse = vi.fn<() => Promise<void>>();

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onChange.mockReset();
    onBrowse.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(overrides: Partial<Parameters<typeof RenderDestinationFields>[0]> = {}) {
    await act(async () => root.render(createElement(RenderDestinationFields, {
      directory: "/Audio exports", canBrowse: true, choosing: false, error: null,
      disabled: false, onChange, onBrowse, ...overrides,
    })));
  }

  it("labels remote and browser paths as belonging to Core and hides local Browse", async () => {
    await render({ canBrowse: false });
    const label = container.querySelector("label")!;
    expect(label.textContent).toBe("Output folder on Core");
    expect(container.textContent).toContain("absolute folder path on the Core computer");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.includes("Browse")))
      .toBe(false);
    expect(container.querySelector("input")!.getAttribute("aria-describedby"))
      .toBe(container.querySelector("p")!.id);
  });

  it("lets the operator explicitly return to the standard destination", async () => {
    await render();
    const defaultButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Use default")!;
    act(() => defaultButton.click());
    expect(onChange).toHaveBeenCalledWith("");
    await render({ directory: "" });
    expect(container.textContent).not.toContain("Use default");
    expect(container.querySelector("input")!.placeholder).toBe("Standard Exports folder");
  });

  it.each(["rendering", "choosing"])("disables destination editing and actions while %s", async (busy) => {
    await render({ disabled: busy === "rendering", choosing: busy === "choosing" });
    expect(container.querySelector("input")!.disabled).toBe(true);
    for (const button of container.querySelectorAll("button")) {
      expect(button.disabled).toBe(true);
      act(() => button.click());
    }
    expect(onBrowse).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("surfaces a destination error as an alert", async () => {
    await render({ error: "Output directory is not writable" });
    expect(container.querySelector('[role="alert"]')!.textContent)
      .toBe("Output directory is not writable");
  });
});
