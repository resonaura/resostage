import { EmptyState } from "@heroui/react";
import { FolderUp, Music4, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./ui";

/**
 * What an empty project offers instead of describing itself.
 *
 * "No songs in this project" is a sentence the operator already knows to be
 * true -- they are looking at an empty screen. It also left the one thing they
 * need next (make a song) somewhere else entirely, behind a tab and a small
 * icon button, so the emptiest state in the app was also the one with the
 * fewest ways out of it.
 *
 * The actions live here rather than in each caller because both surfaces that
 * can be empty -- the timeline and the song list -- want exactly the same two,
 * and the timeline had no way to offer them at all.
 */

export interface EmptyProjectAction {
  key: string;
  label: string;
  description?: string;
  icon: ReactNode;
  /** The one action that is the obvious next step; drawn as the primary. */
  primary?: boolean;
  onPress: () => void;
}

export function EmptyProjectState({
  title,
  description,
  actions,
  compact = false,
  className = "",
}: {
  title: string;
  description?: string;
  actions: EmptyProjectAction[];
  /** Tighter layout for a narrow panel (the song list) rather than a full pane. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <EmptyState
      className={`flex min-h-0 flex-col items-center justify-center gap-3 text-center ${
        compact ? "px-4 py-8" : "h-full px-6 py-10"
      } ${className}`}
    >
      <div className="flex flex-col items-center gap-1.5">
        <Music4
          size={compact ? 20 : 26}
          className="text-foreground opacity-50"
          aria-hidden
        />
        <div
          className={`font-semibold text-foreground/80 ${
            compact ? "text-sm" : "text-base"
          }`}
        >
          {title}
        </div>
        {description && (
          <p className="max-w-xs text-xs leading-relaxed text-foreground/45">
            {description}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        {actions.map((a) => (
          <Button
            key={a.key}
            size="sm"
            // The obvious next step is solid; the alternatives are outlines, so
            // the pair reads as "do this, or one of these" rather than as two
            // equal choices.
            variant={a.primary ? "accent-soft" : "outline"}
            onPress={a.onPress}
            aria-label={a.description ?? a.label}
          >
            {a.icon}
            {a.label}
          </Button>
        ))}
      </div>
    </EmptyState>
  );
}

/** The two things worth doing with a project that has no songs in it. */
export function emptyProjectActions({
  onCreateSong,
  onImportFolder,
}: {
  onCreateSong: () => void;
  onImportFolder?: () => void;
}): EmptyProjectAction[] {
  const actions: EmptyProjectAction[] = [
    {
      key: "create",
      label: "Create song",
      description: "Add an empty song to the setlist",
      icon: <Plus size={14} />,
      primary: true,
      onPress: onCreateSong,
    },
  ];
  if (onImportFolder)
    actions.push({
      key: "import",
      label: "Import folder…",
      description: "Build a song from a folder of stems",
      icon: <FolderUp size={14} />,
      onPress: onImportFolder,
    });
  return actions;
}
