import { FolderOpen } from "lucide-react";
import { ProjectLightingPanel } from "../components/light/ProjectLightingPanel";
import type { WebUiState } from "../lib/types";

export function LightScreen({ state }: { state: WebUiState }) {
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-auto pt-4 pb-6">
      <div className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-accent">
          <FolderOpen size={12} />
          Project-level setting
        </span>
        <span className="text-xs text-foreground/50">
          — saved with the project file, not global rig preferences
        </span>
      </div>
      <ProjectLightingPanel li={state.lighting} state={state} />
    </div>
  );
}
