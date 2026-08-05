import { useMemo, useState } from "react";
import { Button, Modal, ScrollShadow } from "@heroui/react";
import { Check, FolderUp, Layers, Music } from "lucide-react";
import { builder } from "../lib/api";
import type { WebUiState } from "../lib/types";

export interface StemImportItem {
  file: File;
  filename: string;
  detectedCategory: string;
  targetTrackName: string;
}

const STANDARD_TRACK_NAMES = [
  "Click",
  "Guide",
  "Drums",
  "Percussion",
  "Loops",
  "Bass",
  "Guitars",
  "Synths",
  "Keys",
  "Vocals",
  "Backing Vocals",
  "SFX",
  "Other",
];

function autoDetectStemType(filename: string): string {
  const upper = filename.toUpperCase();
  if (
    upper.includes("CLICK") ||
    upper.includes("METRO") ||
    upper.includes("COUNT")
  )
    return "Click";
  if (
    upper.includes("GUIDE") ||
    upper.includes("CUE") ||
    upper.includes("SLATE")
  )
    return "Guide";
  if (upper.includes("BASS") || upper.includes("BS") || upper.includes("SUB"))
    return "Bass";
  if (
    upper.includes("DRUM") ||
    upper.includes("DRM") ||
    upper.includes("KICK") ||
    upper.includes("SNARE") ||
    upper.includes("BEAT") ||
    upper.includes("HAT") ||
    upper.includes("CYMBAL") ||
    upper.includes("TOM")
  )
    return "Drums";
  if (
    upper.includes("PERC") ||
    upper.includes("SHAKER") ||
    upper.includes("CONGA") ||
    upper.includes("TAMB") ||
    upper.includes("CLAP")
  )
    return "Percussion";
  if (
    upper.includes("LOOP") ||
    upper.includes("TOPS") ||
    upper.includes("GROOVE")
  )
    return "Loops";
  if (
    upper.includes("BACK") ||
    upper.includes("BK") ||
    upper.includes("BGV") ||
    upper.includes("BVOX") ||
    upper.includes("BACKING") ||
    upper.includes("CHOIR") ||
    upper.includes("HARMONY") ||
    upper.includes("SECOND")
  )
    return "Backing Vocals";
  if (
    upper.includes("VOX") ||
    upper.includes("VOCAL") ||
    upper.includes("LEAD") ||
    upper.includes("MAIN_VOX")
  )
    return "Vocals";
  if (
    upper.includes("KEY") ||
    upper.includes("PIANO") ||
    upper.includes("ORGAN") ||
    upper.includes("RHODES")
  )
    return "Keys";
  if (
    upper.includes("SYNTH") ||
    upper.includes("PAD") ||
    upper.includes("ARP") ||
    upper.includes("LEAD_SYNTH")
  )
    return "Synths";
  if (
    upper.includes("GUITAR") ||
    upper.includes("GTR") ||
    upper.includes("ACOUSTIC") ||
    upper.includes("ELECTRIC")
  )
    return "Guitars";
  if (
    upper.includes("SFX") ||
    upper.includes("FX") ||
    upper.includes("RISER") ||
    upper.includes("SWEEP") ||
    upper.includes("HIT") ||
    upper.includes("NOISE") ||
    upper.includes("DROP")
  )
    return "SFX";
  if (
    upper.includes("BRASS") ||
    upper.includes("HORN") ||
    upper.includes("STRINGS") ||
    upper.includes("ORCH")
  )
    return "Synths";
  return "Other";
}

export function autoDetectBpm(filename: string): number {
  const match =
    filename.match(/(\d{2,3})\s*BPM/i) || filename.match(/BPM\s*(\d{2,3})/i);
  if (match) return parseInt(match[1], 10);
  return 120;
}

export function autoDetectSongName(folderNameOrFileName: string): string {
  let name = folderNameOrFileName.replace(/\.(wav|mp3|aif|flac)$/i, "");
  name = name.replace(/_\d{2,3}BPM/i, "").replace(/_\d{2,3}bpm/i, "");
  name = name.replace(/[-_]/g, " ").trim();
  return name ? name.toUpperCase() : "UNTITLED SONG";
}

export interface ImportStemsModalProps {
  isOpen: boolean;
  onClose: () => void;
  files: File[];
  folderName?: string;
  state: WebUiState;
}

export function ImportStemsModal({
  isOpen,
  onClose,
  files,
  folderName,
  state,
}: ImportStemsModalProps) {
  // Existing consolidated track names from current project state + standard defaults
  const availableTrackNames = useMemo(() => {
    const names = new Set<string>(STANDARD_TRACK_NAMES);
    state.tracks.forEach((t) => {
      if (t.name) names.add(t.name);
    });
    return Array.from(names);
  }, [state.tracks]);

  // Initial auto-detection
  const initialSongName = useMemo(() => {
    if (folderName) return autoDetectSongName(folderName);
    if (files.length > 0) return autoDetectSongName(files[0].name);
    return "NEW SONG";
  }, [files, folderName]);

  const initialBpm = useMemo(() => {
    for (const f of files) {
      const bpm = autoDetectBpm(f.name);
      if (bpm !== 120) return bpm;
    }
    return 120;
  }, [files]);

  const [songName, setSongName] = useState(initialSongName);
  const [bpm, setBpm] = useState(initialBpm);
  const [tsNum, setTsNum] = useState(4);
  const [tsDen, setTsDen] = useState(4);
  const [isImporting, setIsImporting] = useState(false);

  // Mapped stem items: Click stems default to using built-in C++ click
  // generator. When two files auto-detect to the same category (e.g. two
  // "Guitars" stems), default their target names to distinct tracks
  // ("Guitars", "Guitars 2") up front -- a track can only hold one file
  // (TrackDef.file is a single string), so leaving both defaulted to the
  // same name would make the upload step below silently overwrite the
  // first file with the second once actually imported.
  const [stemMappings, setStemMappings] = useState<StemImportItem[]>(() => {
    const seenCounts: Record<string, number> = {};
    return files.map((file) => {
      const category = autoDetectStemType(file.name);
      const isClick = category === "Click";
      if (isClick) {
        return {
          file,
          filename: file.name,
          detectedCategory: category,
          targetTrackName: "(Use Built-in Metronome)",
        };
      }
      const occurrence = (seenCounts[category] ?? 0) + 1;
      seenCounts[category] = occurrence;
      return {
        file,
        filename: file.name,
        detectedCategory: category,
        targetTrackName:
          occurrence === 1 ? category : `${category} ${occurrence}`,
      };
    });
  });

  const handleTargetChange = (index: number, newTarget: string) => {
    setStemMappings((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], targetTrackName: newTarget };
      return next;
    });
  };

  const handleConfirmImport = async () => {
    setIsImporting(true);
    try {
      await executeStemImport(songName, bpm, tsNum, tsDen, stemMappings, state);
      onClose();
    } catch (err) {
      console.error("Stem import failed:", err);
    } finally {
      setIsImporting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen}>
      <Modal.Backdrop isDismissable={false} isKeyboardDismissDisabled={true}>
        <Modal.Container size="lg" placement="center">
          <Modal.Dialog className="dark bg-surface text-foreground border border-default/40 rounded-xl p-4 shadow-2xl">
            <Modal.Header className="flex flex-col gap-1 border-b border-default/20 pb-3">
              <div className="flex items-center gap-2 text-lg font-bold text-accent">
                <FolderUp size={20} />
                Import Song Stems
              </div>
              <div className="text-xs text-foreground/50 font-normal">
                Auto-detected stem categories and track consolidation mapping
              </div>
            </Modal.Header>

            <Modal.Body className="p-0">
              <ScrollShadow
                orientation="vertical"
                className="flex flex-col gap-4 p-4 max-h-[70vh]"
              >
                {/* Song Information Inputs */}
                <div className="grid grid-cols-3 gap-3 bg-default/10 p-3 rounded-lg border border-default/20">
                  <div className="col-span-1 flex flex-col gap-1">
                    <label className="text-[10px] font-semibold uppercase text-foreground/50">
                      Song Title
                    </label>
                    <input
                      value={songName}
                      onChange={(e) => setSongName(e.target.value)}
                      className="w-full rounded border border-default/40 bg-surface px-2.5 py-1.5 text-xs font-semibold text-foreground focus:border-accent focus:outline-none"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-semibold uppercase text-foreground/50">
                      BPM (Tempo)
                    </label>
                    <input
                      type="number"
                      value={bpm}
                      onChange={(e) =>
                        setBpm(parseFloat(e.target.value) || 120)
                      }
                      className="w-full rounded border border-default/40 bg-surface px-2.5 py-1.5 text-xs font-semibold text-foreground focus:border-accent focus:outline-none"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] font-semibold uppercase text-foreground/50">
                      Time Signature
                    </label>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={tsNum}
                        onChange={(e) =>
                          setTsNum(parseInt(e.target.value) || 4)
                        }
                        className="w-full rounded border border-default/40 bg-surface px-2 py-1.5 text-xs font-semibold text-foreground text-center focus:border-accent focus:outline-none"
                      />
                      <span className="text-foreground/40 font-bold">/</span>
                      <input
                        type="number"
                        value={tsDen}
                        onChange={(e) =>
                          setTsDen(parseInt(e.target.value) || 4)
                        }
                        className="w-full rounded border border-default/40 bg-surface px-2 py-1.5 text-xs font-semibold text-foreground text-center focus:border-accent focus:outline-none"
                      />
                    </div>
                  </div>
                </div>

                {/* Consolidated Track Channel Mapping Table */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-xs font-bold text-foreground/70">
                    <span className="flex items-center gap-1.5">
                      <Layers size={14} className="text-accent" />
                      Stem Track Consolidation ({stemMappings.length} files)
                    </span>
                    <span className="text-[10px] text-foreground/40 font-normal">
                      Maps files to consolidated global track channels
                    </span>
                  </div>

                  <div className="divide-y divide-default/15 border border-default/30 rounded-lg overflow-hidden bg-surface/50">
                    {stemMappings.map((item, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <Music
                            size={14}
                            className="shrink-0 text-foreground/40"
                          />
                          <span
                            className="truncate font-mono text-[11px] font-medium text-foreground/90"
                            title={item.filename}
                          >
                            {item.filename}
                          </span>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-accent/15 text-accent border border-accent/20">
                            {item.detectedCategory}
                          </span>

                          <select
                            value={item.targetTrackName}
                            onChange={(e) =>
                              handleTargetChange(idx, e.target.value)
                            }
                            className="rounded border border-default/40 bg-surface px-2 py-1 text-xs font-semibold text-foreground focus:border-accent focus:outline-none"
                          >
                            {item.detectedCategory === "Click" && (
                              <option value="(Use Built-in Metronome)">
                                ✔ Use Built-in Metronome
                              </option>
                            )}
                            <optgroup label="Consolidated Tracks">
                              {item.detectedCategory !== "Click" && (
                                <option value={item.detectedCategory}>
                                  Track: {item.detectedCategory}
                                </option>
                              )}
                              {availableTrackNames
                                .filter((n) => n !== item.detectedCategory)
                                .map((name) => (
                                  <option key={name} value={name}>
                                    Track: {name}
                                  </option>
                                ))}
                            </optgroup>
                            <optgroup label="Actions">
                              <option value="(Skip)">
                                (Skip / Do Not Import)
                              </option>
                            </optgroup>
                          </select>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </ScrollShadow>
            </Modal.Body>

            <Modal.Footer className="border-t border-default/20 pt-3 flex justify-end gap-2">
              <Button
                variant="outline"
                onPress={onClose}
                isDisabled={isImporting}
              >
                Cancel
              </Button>
              <Button
                variant="secondary"
                className="bg-accent text-accent-foreground font-semibold"
                onPress={handleConfirmImport}
                isDisabled={isImporting}
              >
                <Check size={16} className="mr-1 inline-block" />
                Confirm &amp; Import Stems
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

export async function executeStemImport(
  songName: string,
  bpm: number,
  tsNum: number,
  tsDen: number,
  stemMappings: StemImportItem[],
  state: WebUiState,
) {
  await builder.songAdd(true);
  const songIndex = state.songs.length;

  const enableClick = stemMappings.some(
    (s) =>
      s.detectedCategory === "Click" ||
      s.targetTrackName === "(Use Built-in Metronome)" ||
      s.targetTrackName === "Click",
  );

  await builder.songUpdate({
    index: songIndex,
    name: songName,
    bpm: bpm,
    mode: "auto",
    tsNum: tsNum,
    tsDen: tsDen,
    click: enableClick,
    clickBusId: state.busses[0]?.id || "main",
    clickSends: [],
  });

  const requiredTrackNames = Array.from(
    new Set(
      stemMappings
        .map((s) => s.targetTrackName)
        .filter((t) => t !== "(Skip)" && t !== "(Use Built-in Metronome)"),
    ),
  );

  const currentGlobalTracks = [...state.tracks];
  const trackIndexByName: Record<string, number> = {};

  for (const trackName of requiredTrackNames) {
    let globalIndex = currentGlobalTracks.findIndex(
      (t) => (t.name || t.id).toLowerCase() === trackName.toLowerCase(),
    );
    if (globalIndex < 0) {
      await builder.trackAdd(songIndex);
      globalIndex = currentGlobalTracks.length;
      const newTrack = {
        id: `trk_${globalIndex + 1}`,
        name: trackName,
        busId: state.busses[0]?.id || "main",
        gainDb: 0,
        pan: 0,
        mute: false,
        solo: false,
        sends: [],
        peakDb: -100,
      };
      currentGlobalTracks.push(newTrack);
      await builder.trackUpdate({
        songIndex,
        index: globalIndex,
        name: trackName,
        busId: state.busses[0]?.id || "main",
        gainDb: 0,
        pan: 0,
        mute: false,
        solo: false,
      });
    }
    trackIndexByName[trackName] = globalIndex;
  }

  const uploadCountByName: Record<string, number> = {};
  for (const item of stemMappings) {
    if (
      item.targetTrackName === "(Skip)" ||
      item.targetTrackName === "(Use Built-in Metronome)"
    )
      continue;

    const baseName = item.targetTrackName;
    const occurrence = (uploadCountByName[baseName] ?? 0) + 1;
    uploadCountByName[baseName] = occurrence;

    let targetIndex = trackIndexByName[baseName];
    if (occurrence > 1) {
      const disambiguatedName = `${baseName} ${occurrence}`;
      let disambiguatedIndex = currentGlobalTracks.findIndex(
        (t) =>
          (t.name || t.id).toLowerCase() === disambiguatedName.toLowerCase(),
      );
      if (disambiguatedIndex < 0) {
        await builder.trackAdd(songIndex);
        disambiguatedIndex = currentGlobalTracks.length;
        const newTrack = {
          id: `trk_${disambiguatedIndex + 1}`,
          name: disambiguatedName,
          busId: state.busses[0]?.id || "main",
          gainDb: 0,
          pan: 0,
          mute: false,
          solo: false,
          sends: [],
          peakDb: -100,
        };
        currentGlobalTracks.push(newTrack);
        await builder.trackUpdate({
          songIndex,
          index: disambiguatedIndex,
          name: disambiguatedName,
          busId: state.busses[0]?.id || "main",
          gainDb: 0,
          pan: 0,
          mute: false,
          solo: false,
        });
      }
      targetIndex = disambiguatedIndex;
    }

    if (targetIndex !== undefined) {
      await builder.trackImportWav(songIndex, targetIndex, item.file);
    }
  }
}

export function autoDetectStemMappings(files: File[]): StemImportItem[] {
  const seenCounts: Record<string, number> = {};
  return files.map((file) => {
    const category = autoDetectStemType(file.name);
    const isClick = category === "Click";
    if (isClick) {
      return {
        file,
        filename: file.name,
        detectedCategory: category,
        targetTrackName: "(Use Built-in Metronome)",
      };
    }
    const occurrence = (seenCounts[category] ?? 0) + 1;
    seenCounts[category] = occurrence;
    return {
      file,
      filename: file.name,
      detectedCategory: category,
      targetTrackName:
        occurrence === 1 ? category : `${category} ${occurrence}`,
    };
  });
}
