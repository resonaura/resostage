/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { useRef, useState } from "react";
import {
  autoDetectBpm,
  autoDetectSongName,
  autoDetectStemMappings,
  executeStemImport,
} from "@/transfer/audio/logic/stemImport";
import type { WebUiState } from "@/lib/state/types";

/** Manages importing one or more song folders from the editor's Songs tab. */
export function useStemFolderImport(state: WebUiState) {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [importFolder, setImportFolder] = useState("");
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);

  const handleImportFolderClick = () => {
    if (folderInputRef.current) {
      folderInputRef.current.click();
    }
  };

  const handleFolderChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const allFiles = Array.from(e.target.files ?? []).filter(
      (file) =>
        file.name.toLowerCase().endsWith(".wav") ||
        file.name.toLowerCase().endsWith(".mp3") ||
        file.name.toLowerCase().endsWith(".aif") ||
        file.name.toLowerCase().endsWith(".flac"),
    );
    e.target.value = "";
    if (allFiles.length === 0) return;

    const filesBySongFolder: Record<string, File[]> = {};

    for (const file of allFiles) {
      const relPath = file.webkitRelativePath || file.name;
      const parts = relPath.split("/").filter(Boolean);
      let songFolderName = "IMPORTED SONG";

      if (parts.length >= 3) {
        songFolderName = parts[parts.length - 2];
      } else if (parts.length === 2) {
        songFolderName = parts[0];
      } else {
        songFolderName = autoDetectSongName(file.name);
      }

      if (!filesBySongFolder[songFolderName]) {
        filesBySongFolder[songFolderName] = [];
      }
      filesBySongFolder[songFolderName].push(file);
    }

    const songFolders = Object.keys(filesBySongFolder);

    if (songFolders.length === 1) {
      const folderName = songFolders[0];
      setImportFiles(filesBySongFolder[folderName]);
      setImportFolder(folderName);
      setIsImportModalOpen(true);
      return;
    }

    for (const folderName of songFolders) {
      const songFiles = filesBySongFolder[folderName];
      const songName = autoDetectSongName(folderName);
      let bpm = 120;
      for (const file of songFiles) {
        const detected = autoDetectBpm(file.name);
        if (detected !== 120) {
          bpm = detected;
          break;
        }
      }
      const mappings = autoDetectStemMappings(songFiles);
      await executeStemImport(songName, bpm, 4, 4, mappings, state);
    }
  };

  return {
    folderInputRef,
    importFiles,
    importFolder,
    isImportModalOpen,
    setIsImportModalOpen,
    handleImportFolderClick,
    handleFolderChosen,
  };
}
