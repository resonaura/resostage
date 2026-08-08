import { Alert } from "@heroui/react";
import { FolderOpen } from "lucide-react";
import { ProjectLightingPanel } from "../components/light/ProjectLightingPanel";
import type { WebUiState } from "../lib/types";

export function LightScreen({ state }: { state: WebUiState }) {
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 overflow-auto pt-4 pb-6">
      <Alert status="accent">
        <Alert.Indicator>
          <FolderOpen size={14} />
        </Alert.Indicator>
        <Alert.Content>
          <Alert.Title className="text-xs font-semibold uppercase tracking-wide">
            Project-level setting
          </Alert.Title>
          <Alert.Description className="text-xs">
            Saved with the project file, not global rig preferences.
          </Alert.Description>
        </Alert.Content>
      </Alert>
      <ProjectLightingPanel li={state.lighting} state={state} />
    </div>
  );
}
