/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { mixer, pluginChains } from "@/lib/state/api";
import { getTrackLiveLevel } from "@/lib/audio/liveLevels";
import {
  outputSendsToClickRows,
  sourceOutputBusId,
} from "@/lib/state/types";
import { InstrumentContextMenu } from "@/screens/mixer/plugins/InstrumentContextMenu";
import { resolveTrackPolarity, toggleTrackPolarity } from "@/screens/mixer/logic/polarity";
import { ChannelStrip } from "@/screens/mixer/strips/ChannelStrip";
import { colorForIndex } from "@/screens/mixer/logic/constants";
import { getTrackInputOptions, getTrackInputState } from "@/screens/mixer/logic/trackInputs";
import { PolarityContextMenu } from "@/screens/mixer/strips/PolarityContextMenu";
import { areTrackStripPropsEqual } from "@/screens/mixer/strips/logic/trackStripMemo";
import type { TrackStripProps } from "@/screens/mixer/strips/types";
import { rotaryMidiTarget } from "@/components/daw/logic/rotaryMidiTarget";

function TrackStripInner({
  t,
  index,
  destinationBusses,
  allBusses,
  auxBusses,
  meters,
  settings,
  anySoloInGroup,
  pluginCatalog,
  isRecording = false,
  isFocused = false,
  density = "standard",
  targetPluginSlots,
  onDirectOutput,
  onOpenPlugins,
}: TrackStripProps) {
  const color = colorForIndex(index);
  const busId = sourceOutputBusId(t.output);
  const busMeter = meters.find((m) => m.id === busId);
  const peakDb = t.peakDb ?? busMeter?.peakDb;
  const peakDbL = t.peakDbL ?? busMeter?.peakDbL ?? peakDb;
  const peakDbR = t.peakDbR ?? busMeter?.peakDbR ?? peakDb;

  const { isInstrument, canRecord, canMonitorInput, isMono, currentInput } =
    getTrackInputState(t);

  const [optimisticPolarity, setOptimisticPolarity] = useState<
    "left" | "right" | "none" | "both" | null
  >(null);
  const lastPolarityEdit = useRef(0);
  const polarity = resolveTrackPolarity(
    optimisticPolarity,
    t.polarity,
    t.phaseInvert,
  );
  const isPolarityActive = polarity !== "none";
  const [polarityMenu, setPolarityMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (Date.now() - lastPolarityEdit.current > 1200) {
      setOptimisticPolarity(null);
    }
  }, [t.polarity, t.phaseInvert]);

  const togglePolarity = () => {
    const nextPolarity = toggleTrackPolarity(polarity, isMono);
    lastPolarityEdit.current = Date.now();
    setOptimisticPolarity(nextPolarity);
    void mixer.setTrackTrim(
      index,
      t.inputTrimDb ?? 0,
      nextPolarity !== "none",
      nextPolarity,
    );
  };

  const instrumentSlot = t.plugins?.find((p) => p.instrument);
  const instrumentName = instrumentSlot?.name;
  const audioFxSlots = useMemo(
    () => (t.plugins ?? []).filter((p) => !p.instrument),
    [t.plugins],
  );
  const [instrumentMenu, setInstrumentMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const inputOptions = getTrackInputOptions({
    isMono,
    inputChannelNames: settings?.inputChannelNames,
    allBusses,
  });

  return (
    <>
      <ChannelStrip
        stripId={t.id}
        name={t.name || t.id}
        subtitle={`Track ${index + 1}`}
        color={color}
        busses={destinationBusses}
        busId={busId}
        formatToggle={{
          stereo: !isMono,
          onToggle: () => void mixer.setTrackMono(index, !isMono),
        }}
        inputRouting={{
          isInstrument,
          instrumentName,
          instrumentSlotId: instrumentSlot?.id,
          instrumentBypassed: instrumentSlot?.bypassed,
          instrumentLoadState: instrumentSlot?.loadState,
          instrumentLoadError: instrumentSlot?.loadError,
          onRetryInstrument: instrumentSlot
            ? () => void pluginChains.retry(t.id, instrumentSlot.id)
            : undefined,
          onToggleInstrumentBypass: instrumentSlot
            ? () =>
                void pluginChains.setBypassed(
                  t.id,
                  instrumentSlot.id,
                  !instrumentSlot.bypassed,
                )
            : undefined,
          onOpenInstrument: () => {
            if (instrumentSlot)
              void pluginChains.openEditor(t.id, instrumentSlot.id);
          },
          onInstrumentMenu: (pos) => setInstrumentMenu(pos),
          inputOptions,
          currentInput,
          onInputChange: (val) =>
            void mixer.setTrackInputSource(
              index,
              val,
              t.midiInputChannel ?? 0,
              t.midiInputDevice ?? "all",
            ),
          polarity,
          onTogglePolarity: togglePolarity,
          onPolarityMenu: (pos) => setPolarityMenu(pos),
          trimDb: t.inputTrimDb ?? 0,
          onTrimChange: (trim) =>
            void mixer.setTrackTrim(index, trim, isPolarityActive, polarity),
        }}
        recordArmed={t.recordArmed}
        inputMonitoring={t.inputMonitoring}
        isRecording={isRecording}
        isFocused={isFocused}
        onRecordArm={
          canRecord
            ? () => void mixer.setTrackRecordArm(index, !t.recordArmed)
            : undefined
        }
        onInputMonitor={
          canMonitorInput
            ? () => void mixer.setTrackInputMonitor(index, !t.inputMonitoring)
            : undefined
        }
        onBusSelect={(bId) => mixer.setTrackBus(index, bId)}
        directOutput={{
          settings,
          allBusses,
          mono: t.channels === 1,
          onMonoChange: (m) => void mixer.setTrackMono(index, m),
          onDirectOutput: (mono, ch, pair) =>
            onDirectOutput(index, mono, ch, pair),
        }}
        sends={{
          auxBusses,
          values: outputSendsToClickRows(t.output),
          trackIndex: index,
          onSendEnabledChange: (sBusId, enabled) => {
            const current = outputSendsToClickRows(t.output).find(
              (s) => s.busId === sBusId,
            );
            void mixer.setTrackSend(
              index,
              sBusId,
              current?.level ?? 100,
              enabled,
            );
          },
        }}
        gainDb={t.gainDb ?? 0}
        pan={t.pan ?? 0}
        panMidiTarget={rotaryMidiTarget.trackPan(t.id)}
        peakDb={peakDb}
        peakDbL={peakDbL}
        peakDbR={peakDbR}
        getLiveDbL={() => getTrackLiveLevel(t.id)?.peakDbL ?? -144}
        getLiveDbR={() => getTrackLiveLevel(t.id)?.peakDbR ?? -144}
        mute={t.mute}
        solo={t.solo}
        soloSafe={t.soloSafe}
        anySoloInGroup={anySoloInGroup}
        pluginSlots={audioFxSlots}
        pluginCatalog={pluginCatalog}
        density={density}
        targetPluginSlots={targetPluginSlots}
        onPlugins={() => onOpenPlugins(t.id, t.name || t.id)}
        onGain={(v) => mixer.setTrackGain(index, v)}
        onPan={(v) => mixer.setTrackPan(index, v)}
        onMute={() => mixer.setTrackMute(index, !t.mute)}
        onSolo={() => mixer.setTrackSolo(index, !t.solo)}
        onSoloSafe={(safe) => void mixer.setTrackSoloSafe(index, safe)}
      />

      <PolarityContextMenu
        position={polarityMenu}
        isMono={isMono}
        polarity={polarity}
        onSelect={(nextPolarity) =>
          void mixer.setTrackTrim(
            index,
            t.inputTrimDb ?? 0,
            nextPolarity !== "none",
            nextPolarity,
          )
        }
        onClose={() => setPolarityMenu(null)}
      />

      <InstrumentContextMenu
        trackId={t.id}
        isInstrument={isInstrument}
        slot={instrumentSlot}
        name={instrumentName}
        catalog={pluginCatalog}
        position={instrumentMenu}
        onClose={() => setInstrumentMenu(null)}
      />
    </>
  );
}

export const TrackStrip = memo(TrackStripInner, areTrackStripPropsEqual);
