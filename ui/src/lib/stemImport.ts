import { builder } from "./api";
import type { WebUiState } from "./types";

export interface StemImportItem {
  file: File;
  filename: string;
  detectedCategory: string;
  targetTrackName: string;
}

export function autoDetectStemType(filename: string): string {
  const f = filename.toLowerCase();
  if (
    f.includes("click") ||
    f.includes("metronome") ||
    f.includes("count") ||
    f.includes("guide")
  )
    return "Click";
  if (f.includes("bass") || f.includes("808") || f.includes("sub"))
    return "Bass";
  if (
    f.includes("drum") ||
    f.includes("perc") ||
    f.includes("kick") ||
    f.includes("snare") ||
    f.includes("beat") ||
    f.includes("loop")
  )
    return "Drums";
  if (
    f.includes("vox") ||
    f.includes("vocal") ||
    f.includes("lead vox") ||
    f.includes("bgv") ||
    f.includes("chant")
  )
    return "Vocals";
  if (
    f.includes("gtr") ||
    f.includes("guitar") ||
    f.includes("acoustic") ||
    f.includes("electric")
  )
    return "Guitars";
  if (
    f.includes("keys") ||
    f.includes("synth") ||
    f.includes("pad") ||
    f.includes("lead") ||
    f.includes("piano") ||
    f.includes("organ")
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
        channels: 2,
        gainDb: 0,
        pan: 0,
        mute: false,
        solo: false,
        output: { type: "main" as const, target: "audio::main", sends: [] },
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
          channels: 2,
          gainDb: 0,
          pan: 0,
          mute: false,
          solo: false,
          output: { type: "main" as const, target: "audio::main", sends: [] },
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
