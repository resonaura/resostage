import { useState } from "react";
import { EmptyDetailPanel, ListPanel, SongEditor } from "@/screens/editor/components/SongsTab";
import {
  emptyProjectActions,
  EmptyProjectState,
} from "@/screens/editor/project/components/EmptyProjectState";
import { builder } from "@/lib/state/api";
import type { WebUiState } from "@/lib/state/types";

export function SongsEditorTab({
  state,
  folderInputRef,
  onFolderChosen,
  onImportFolder,
}: {
  state: WebUiState;
  folderInputRef: React.RefObject<HTMLInputElement | null>;
  onFolderChosen: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onImportFolder: () => void;
}) {
  const [selected, setSelected] = useState(-1);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is standard in HTML5 directory pickers
        webkitdirectory=""
        directory=""
        multiple
        className="hidden"
        onChange={onFolderChosen}
      />
      <ListPanel
        title="Songs"
        rows={state.songs.map((song, index) => ({
          key: String(index),
          label: `${index + 1}. ${song.name}`,
          sub: `${song.bpm.toFixed(1)} bpm`,
          active: index === state.songIndex,
        }))}
        selected={selected}
        onSelect={setSelected}
        onAdd={() => builder.songAdd()}
        onRemove={() => selected >= 0 && builder.songRemove(selected)}
        onMove={(direction) =>
          selected >= 0 && builder.songMove(selected, direction)
        }
        onImport={onImportFolder}
        empty={
          <EmptyProjectState
            compact
            title="No songs yet"
            description="Start one from scratch, or point at a folder of stems and let the importer build it."
            actions={emptyProjectActions({
              onCreateSong: () => void builder.songAdd(),
              onImportFolder,
            })}
          />
        }
      />
      {selected >= 0 && state.songs[selected] ? (
        <SongEditor
          key={selected}
          song={state.songs[selected]}
          index={selected}
        />
      ) : (
        <EmptyDetailPanel hasRows={state.songs.length > 0} />
      )}
    </div>
  );
}
