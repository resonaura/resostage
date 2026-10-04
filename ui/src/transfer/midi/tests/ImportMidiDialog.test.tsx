/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyState, type SongRow, type WebUiState } from "@/lib/state/types";
import { ImportMidiDialog } from "@/transfer/midi/components/ImportMidiDialog";

vi.mock("@/lib/state/api", () => ({
  builder: {
    midiRegionAdd: vi.fn(),
    songEnd: vi.fn(),
    songUpdate: vi.fn(),
  },
}));

vi.mock("@/components/ui", async () => {
  const React = await import("react");
  const passthrough = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  const Modal = Object.assign(
    ({ isOpen, children }: { isOpen: boolean; children?: ReactNode }) =>
      isOpen ? React.createElement("div", null, children) : null,
    {
      Backdrop: passthrough,
      Container: passthrough,
      Dialog: passthrough,
      CloseTrigger: () => null,
      Header: passthrough,
      Heading: passthrough,
      Body: passthrough,
      Footer: passthrough,
    },
  );
  const Button = ({
    children,
    isDisabled,
    onPress,
  }: {
    children?: ReactNode;
    isDisabled?: boolean;
    onPress?: () => void;
  }) => React.createElement("button", { disabled: isDisabled, onClick: onPress }, children);
  return { Button, Modal };
});

function midiFileWithTempo(bpm: number): File {
  const micros = Math.round(60_000_000 / bpm);
  const bytes = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 1, 0xe0,
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 20,
    0, 0xff, 0x51, 3, (micros >> 16) & 0xff, (micros >> 8) & 0xff, micros & 0xff,
    0, 0x90, 60, 100,
    0x83, 0x60, 0x80, 60, 0,
    0, 0xff, 0x2f, 0,
  ]);
  const file = new File([bytes], `tempo-${bpm}.mid`, { type: "audio/midi" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  return file;
}

const song: SongRow = {
  name: "Song",
  bpm: 120,
  mode: "auto",
  tsNum: 4,
  tsDen: 4,
  endSeconds: 20,
  click: false,
  clickBusId: "",
  clickSends: [],
  events: [],
  tempoPoints: [{ beat: 0, bpm: 120, timeSeconds: 0, curve: 0 }],
  signaturePoints: [{ beat: 0, numerator: 4, denominator: 4, bar: 1 }],
  midiRegions: [],
  regions: [],
};

const state: WebUiState = {
  ...emptyState,
  songIndex: 0,
  activeTrackId: "track-1",
  songs: [song],
  tracks: [{ id: "track-1", kind: "instrument", name: "Instrument" } as WebUiState["tracks"][number]],
};

describe("ImportMidiDialog session state", () => {
  let container: HTMLDivElement;
  let root: Root;
  const file = midiFileWithTempo(90);

  async function render(open: boolean): Promise<void> {
    await act(async () => {
      root.render(createElement(ImportMidiDialog, {
        open,
        files: [file],
        state,
        onClose: () => {},
      }));
    });
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("resets the tempo choice when the dialog is reopened", async () => {
    await render(true);
    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios, container.innerHTML).toHaveLength(3);

    await act(async () => radios[2].click());
    expect(radios[2].checked).toBe(true);

    await render(false);
    await render(true);
    const reopenedRadios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(reopenedRadios[0].checked).toBe(true);
    expect(reopenedRadios[2].checked).toBe(false);
  });
});
