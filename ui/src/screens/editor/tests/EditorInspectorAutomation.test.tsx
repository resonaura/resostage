/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackRow, WebUiState } from "@/lib/state/types";

const { trackStripProps } = vi.hoisted(() => ({ trackStripProps: vi.fn() }));

vi.mock("@/screens/mixer/strips/TrackStrip", () => ({
  TrackStrip: (props: unknown) => {
    trackStripProps(props);
    return null;
  },
}));

import { EditorInspector } from "@/screens/editor/components/EditorInspector";

function track(
  id: string,
  values: Pick<TrackRow, "gainDb" | "pan"> &
    Partial<Pick<TrackRow, "automatedGainDb" | "automatedPan">>,
): TrackRow {
  return {
    id,
    name: id,
    kind: "audio",
    channels: 2,
    gainDb: values.gainDb,
    automatedGainDb: values.automatedGainDb,
    pan: values.pan,
    automatedPan: values.automatedPan,
    mute: false,
    solo: false,
    soloGroup: "sources",
    soloActiveInGroup: false,
    inputSource: "none",
    output: { type: "sends-only", sends: [] },
    peakDb: -100,
    peakDbL: -100,
    peakDbR: -100,
  };
}

function stateFor(tracks: TrackRow[]): WebUiState {
  return {
    tracks,
    busses: [],
    meters: [],
    settings: { inputChannelNames: [] },
    recording: false,
    songIndex: 0,
    songs: [],
  } as unknown as WebUiState;
}

describe("EditorInspector automation identity", () => {
  beforeEach(() => trackStripProps.mockClear());

  it("passes only the newly selected track's evaluated values to its shared strip", () => {
    const first = track("track-a", {
      gainDb: 0,
      automatedGainDb: -18,
      pan: 0,
      automatedPan: -0.5,
    });
    const selected = track("track-b", {
      gainDb: -3,
      automatedGainDb: 4,
      pan: 0.2,
      automatedPan: 0.75,
    });

    renderToStaticMarkup(
      createElement(EditorInspector, {
        state: stateFor([first, selected]),
        selectedTrackId: selected.id,
      }),
    );

    expect(trackStripProps).toHaveBeenCalledOnce();
    const props = trackStripProps.mock.calls[0][0] as { t: TrackRow; index: number };
    expect(props.t).toBe(selected);
    expect(props.t.automatedGainDb).toBe(4);
    expect(props.t.automatedPan).toBe(0.75);
    expect(props.index).toBe(1);
  });

  it("does not carry an old track's automation into a selected track with no active lane", () => {
    const automated = track("track-a", {
      gainDb: 0,
      automatedGainDb: -18,
      pan: 0,
      automatedPan: -0.5,
    });
    const manual = track("track-b", {
      gainDb: -3,
      pan: 0.2,
    });

    renderToStaticMarkup(
      createElement(EditorInspector, {
        state: stateFor([automated, manual]),
        selectedTrackId: manual.id,
      }),
    );

    const props = trackStripProps.mock.calls[0][0] as { t: TrackRow };
    expect(props.t).toBe(manual);
    expect(props.t.automatedGainDb).toBeUndefined();
    expect(props.t.automatedPan).toBeUndefined();
  });
});
