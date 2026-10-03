/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Knob } from "@/components/daw/Knob";
import { SendArcKnob } from "@/components/daw/SendArcKnob";
import { MeterFader } from "@/components/daw/MeterFader";
import { automatableValueForDisplay } from "@/components/daw/logic/automatableValue";
import { outputSendsToClickRows } from "@/lib/state/types";
import { GainFader } from "@/screens/mixer/strips/GainFader";
import { PanControl } from "@/screens/mixer/strips/PanControl";
import { controlDisplayTransition } from "@/components/daw/logic/controlMotion";

describe("automation-driven mixer control values", () => {
  it("eases telemetry-driven control paint without easing a live gesture", () => {
    expect(controlDisplayTransition("top", false)).toContain("120ms");
    expect(controlDisplayTransition("transform", false)).toContain("cubic-bezier");
    expect(controlDisplayTransition("left", true)).toBe("none");
  });

  it("prefers optimistic edits until they reconcile with authoritative state", () => {
    expect(automatableValueForDisplay(-12, -6, -9)).toBe(-9);
    expect(automatableValueForDisplay(-12, -6, -12)).toBe(-6);
    expect(automatableValueForDisplay(-12, Number.NaN, -12)).toBe(-12);
  });

  it("keeps Core automation separate when projecting source send rows", () => {
    expect(
      outputSendsToClickRows({
        type: "main",
        sends: [
          {
            bus: "audio::send:1",
            level: 40,
            automatedLevel: 75,
            enabled: true,
          },
        ],
      }),
    ).toEqual([
      {
        busId: "audio::send:1",
        level: 40,
        automatedLevel: 75,
        enabled: true,
        preFader: undefined,
        tap: "post-pan",
      },
    ]);
  });

  it("places a knob at the evaluated pan and displays its label", () => {
    const markup = renderToStaticMarkup(
      createElement(PanControl, {
        value: 0,
        automatedValue: 1,
        onChange: vi.fn(),
        size: 24,
      }),
    );

    expect(markup).toContain("rotate(135deg)");
    expect(markup).toContain(">R100</div>");
  });

  it("positions the mixer meter-fader from automation without changing its edit baseline", () => {
    const markup = renderToStaticMarkup(
      createElement(MeterFader, {
        value: -12,
        automationValue: 12,
        cancelValue: -12,
        min: -60,
        max: 12,
        dbL: -144,
        dbR: -144,
        onChange: vi.fn(),
      }),
    );

    expect(markup).toContain('aria-valuenow="12"');
    expect(markup).toContain("(100% - 16px) * 1");
  });

  it("moves the mixer dB fader with automation while retaining the manual value prop", () => {
    const markup = renderToStaticMarkup(
      createElement(GainFader, {
        value: -12,
        automationValue: 12,
        onChange: vi.fn(),
      }),
    );

    expect(markup).toContain("top:0%");
  });

  it("displays automation on a shared knob while keeping cancellation on the manual value", () => {
    const markup = renderToStaticMarkup(
      createElement(Knob, {
        value: -1,
        automationValue: 1,
        cancelValue: -1,
        min: -1,
        max: 1,
        onCommit: vi.fn(),
        size: 24,
      }),
    );

    expect(markup).toContain('aria-valuenow="1"');
    expect(markup).toContain("rotate(135deg)");
  });

  it("rotates a shared pan knob to the evaluated endpoint", () => {
    const markup = renderToStaticMarkup(
      createElement(Knob, {
        value: -1,
        min: -1,
        max: 1,
        onCommit: vi.fn(),
        size: 24,
      }),
    );

    expect(markup).toContain('aria-valuenow="-1"');
    expect(markup).toContain("rotate(-135deg)");
  });

  it("positions an automated send arc while retaining its manual edit baseline", () => {
    const markup = renderToStaticMarkup(
      createElement(SendArcKnob, {
        value: -60,
        automationValue: -12,
        cancelValue: -60,
        min: -60,
        max: 0,
        busColor: "var(--accent)",
        onChange: vi.fn(),
      }),
    );

    expect(markup).toContain('aria-valuenow="-12"');
    expect(markup).toContain("stroke-dashoffset");
  });
});
