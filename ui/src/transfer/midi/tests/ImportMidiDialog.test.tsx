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
import { builder, EditorMutationError } from "@/lib/state/api";
import { ImportMidiDialog } from "@/transfer/midi/components/ImportMidiDialog";

vi.mock("@/lib/state/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state/api")>();
  return {
    ...actual,
    builder: {
      ...actual.builder,
      midiRegionAdd: vi.fn(),
      songEnd: vi.fn(),
      songUpdate: vi.fn(),
      trackAdd: vi.fn(),
    },
  };
});

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

function midiFileWithTwoTracks(): File {
  const makeTrack = (name: string, pitch: number): number[] => {
    const nameBytes = [...new TextEncoder().encode(name)];
    const body = [
      0, 0xff, 0x03, nameBytes.length, ...nameBytes,
      0, 0x90, pitch, 100,
      0x83, 0x60, 0x80, pitch, 0,
      0, 0xff, 0x2f, 0,
    ];
    return [0x4d, 0x54, 0x72, 0x6b,
      (body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff,
      (body.length >>> 8) & 0xff, body.length & 0xff, ...body];
  };
  const bytes = new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 2, 1, 0xe0,
    ...makeTrack("Piano", 60),
    ...makeTrack("Strings", 67),
  ]);
  const file = new File([bytes], "two-track.mid", { type: "audio/midi" });
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

  async function render(
    open: boolean,
    files: File[] = [file],
    target?: { songIndex: number; trackId?: string; startBeats?: number },
  ): Promise<void> {
    await act(async () => {
      root.render(createElement(ImportMidiDialog, {
        open,
        files,
        state,
        target,
        onClose: () => {},
      }));
    });
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
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
    const tempoFieldset = [...container.querySelectorAll("fieldset")]
      .find((fieldset) => fieldset.textContent?.includes("MIDI tempo differs from the song"));
    const radios = [...(tempoFieldset?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? [])];
    expect(radios, container.innerHTML).toHaveLength(3);

    await act(async () => radios[2].click());
    expect(radios[2].checked).toBe(true);

    await render(false);
    await render(true);
    const reopenedTempoFieldset = [...container.querySelectorAll("fieldset")]
      .find((fieldset) => fieldset.textContent?.includes("MIDI tempo differs from the song"));
    const reopenedRadios = [...(reopenedTempoFieldset?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? [])];
    expect(reopenedRadios[0].checked).toBe(true);
    expect(reopenedRadios[2].checked).toBe(false);
  });

  it("preserves source MIDI tracks as separate instrument tracks by default", async () => {
    vi.mocked(builder.trackAdd).mockResolvedValue(undefined);
    vi.mocked(builder.midiRegionAdd).mockResolvedValue(undefined);
    await render(true, [midiFileWithTwoTracks()]);

    const layoutRadios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(layoutRadios[0].checked).toBe(true);
    const importButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Import");
    await act(async () => {
      importButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(builder.trackAdd).toHaveBeenCalledTimes(2);
    const createdTracks = vi.mocked(builder.trackAdd).mock.calls.map(([, params]) => params!);
    expect(createdTracks).toMatchObject([
      { kind: "instrument", name: "two-track — Piano", seedMidiRegion: false },
      { kind: "instrument", name: "two-track — Strings", seedMidiRegion: false },
    ]);
    expect(builder.midiRegionAdd).toHaveBeenCalledTimes(2);
    const regions = vi.mocked(builder.midiRegionAdd).mock.calls.map(([patch]) => patch);
    expect(regions.map((patch) => patch.trackId)).toEqual(createdTracks.map((track) => track.id));
    expect(regions.map((patch) => patch.notes?.map((note) => note.pitch) ?? [])).toEqual([[60], [67]]);
    expect(regions.map((patch) => patch.startBeats)).toEqual([0, 0]);
  });

  it("keeps explicit destination-track imports combined", async () => {
    vi.mocked(builder.midiRegionAdd).mockResolvedValue(undefined);
    await render(true, [midiFileWithTwoTracks()], { songIndex: 0, trackId: "track-1" });

    const layoutRadios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(layoutRadios[0].checked).toBe(false);
    expect(layoutRadios[1].checked).toBe(true);
    const importButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Import");
    await act(async () => {
      importButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(builder.trackAdd).not.toHaveBeenCalled();
    expect(builder.midiRegionAdd).toHaveBeenCalledTimes(1);
    expect(vi.mocked(builder.midiRegionAdd).mock.calls[0][0].notes?.map((note) => note.pitch))
      .toEqual([60, 67]);
  });

  it("reports confirmed earlier regions when a later file is rejected", async () => {
    vi.mocked(builder.midiRegionAdd)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new EditorMutationError(
        "Core rejected the edit (HTTP 400)", "rejected", "/api/v1/builder/midi-region/add", 2,
      ));
    await render(true, [midiFileWithTempo(90), midiFileWithTempo(100)]);
    const importButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Import");
    expect(importButton).toBeTruthy();

    await act(async () => {
      importButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(builder.midiRegionAdd).toHaveBeenCalledTimes(2);
    const alert = container.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain("1 of 2 MIDI regions");
    expect(alert).toContain("Earlier confirmed changes were not rolled back");
    expect(importButton?.disabled).toBe(true);
  });

  it("warns and does not retry when a region mutation outcome is unknown", async () => {
    vi.mocked(builder.midiRegionAdd).mockRejectedValueOnce(new EditorMutationError(
      "Core did not confirm the project edit before timeout",
      "unknown",
      "/api/v1/builder/midi-region/add",
      1,
    ));
    await render(true);
    const importButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Import");

    await act(async () => {
      importButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(builder.midiRegionAdd).toHaveBeenCalledTimes(1);
    const alert = container.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain("outcome of region 1 of 1");
    expect(alert).toContain("Do not retry");
    expect(importButton?.disabled).toBe(true);
  });

  it("reports a region as committed when playback publication is uncertain", async () => {
    vi.mocked(builder.midiRegionAdd).mockRejectedValueOnce(new EditorMutationError(
      "Core stored the project edit, but audio is using its last valid snapshot",
      "stored",
      "/api/v1/builder/midi-region/add",
      1,
    ));
    await render(true);
    const importButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Import");

    await act(async () => {
      importButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(builder.midiRegionAdd).toHaveBeenCalledTimes(1);
    const alert = container.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain("1 of 1 MIDI regions");
    expect(alert).toContain("last valid snapshot");
    expect(alert).toContain("request's project history");
    expect(importButton?.disabled).toBe(true);
  });

  it("blocks retry after a region rejection leaves a confirmed empty imported track", async () => {
    vi.mocked(builder.midiRegionAdd).mockRejectedValueOnce(new EditorMutationError(
      "Core rejected the edit (HTTP 400)",
      "rejected",
      "/api/v1/builder/midi-region/add",
      1,
    ));
    await render(true);
    const importButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Import");

    await act(async () => {
      importButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(builder.midiRegionAdd).toHaveBeenCalledTimes(1);
    expect(builder.trackAdd).toHaveBeenCalledTimes(1);
    expect(importButton?.disabled).toBe(true);
    const alert = container.querySelector('[role="alert"]')?.textContent ?? "";
    expect(alert).toContain("1 of 1 new MIDI tracks");
    expect(alert).toContain("Earlier confirmed changes were not rolled back");
  });
});
