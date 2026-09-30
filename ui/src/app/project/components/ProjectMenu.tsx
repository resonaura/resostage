import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../dialogs/components/ConfirmDialog";
import { ContextMenu, ContextMenuDivider, ContextMenuItem } from "../../../components/common/ContextMenu";
import { Button } from "../../../components/ui";
import { project } from "../../../lib/state/api";
import { IS_EMBEDDED } from "../../../lib/platform/embedded";
import { hotkeyManager, HotkeyScope } from "../../../lib/interaction/HotkeyManager";
import type { WebUiState } from "../../../lib/state/types";
import type { RenderDialogIntent } from "../../render/components/RenderAudioDialog";

export function ProjectMenu({
  state,
  onRender,
}: {
  state: WebUiState;
  onRender: (intent: RenderDialogIntent) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [confirmNew, setConfirmNew] = useState(false);
  const [saveLabel, setSaveLabel] = useState("Save");
  const saveFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recentBtnRef = useRef<HTMLButtonElement>(null);
  const projectDropdownRef = useRef<HTMLButtonElement>(null);
  const [recentAnchor, setRecentAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [projectMenuAnchor, setProjectMenuAnchor] = useState<{
    x: number;
    y: number;
  } | null>(null);

  // Mirror native status: "Saving…" while busy, then flash "Saved".
  useEffect(() => {
    const msg = state.statusMessage ?? "";
    if (/^Saving\b/i.test(msg) || state.busy) {
      setSaveLabel("Saving…");
      return;
    }
    if (!/^Saved\b/i.test(msg)) return;
    setSaveLabel("Saved");
    if (saveFlashTimer.current) clearTimeout(saveFlashTimer.current);
    saveFlashTimer.current = setTimeout(() => setSaveLabel("Save"), 1800);
    return () => {
      if (saveFlashTimer.current) clearTimeout(saveFlashTimer.current);
    };
  }, [state.statusMessage, state.busy]);

  const handleNew = () => {
    if (
      state.songCount > 0 ||
      (state.projectName && state.projectName !== "New Project")
    ) {
      setConfirmNew(true);
      return;
    }
    void project.new();
  };

  const handleLoad = () => {
    if (IS_EMBEDDED) {
      void project.loadDialog();
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void project.upload(file);
  };

  const handleSave = () => {
    if (IS_EMBEDDED) void project.save();
    else void project.exportAndDownload();
  };
  const handleSaveAs = () => {
    if (IS_EMBEDDED) void project.saveAs();
    else void project.exportAndDownload();
  };

  // Save shortcuts are immutable File commands routed through HotkeyManager.
  useEffect(() => {
    const mod = /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "cmd" : "ctrl";
    const unregister = [
      hotkeyManager.registerCommand(
        "file.save",
        `${mod} + s`,
        { scope: HotkeyScope.Global, priority: 100, allowInTextInput: true },
        (event) => {
          if (event?.shiftKey) return false;
          handleSave();
          return true;
        },
      ),
      hotkeyManager.registerCommand(
        "file.save-as",
        `${mod} + shift + s`,
        { scope: HotkeyScope.Global, priority: 100, allowInTextInput: true },
        () => {
          handleSaveAs();
          return true;
        },
      ),
    ];
    return () => unregister.forEach((dispose) => dispose());
  }, []);

  return (
    <div className="flex items-center gap-1.5">
      <input
        ref={fileInputRef}
        type="file"
        accept=".rsnraset"
        className="hidden"
        onChange={handleFileChosen}
      />

      {/* Desktop view (>= xl): full button row */}
      <div className="hidden xl:flex items-center gap-1.5">
        <Button size="sm" variant="outline" onPress={handleNew}>
          New
        </Button>
        <Button size="sm" variant="outline" onPress={handleLoad}>
          {IS_EMBEDDED ? "Load…" : "Upload…"}
        </Button>
        {IS_EMBEDDED && (
          <Button
            ref={recentBtnRef}
            size="sm"
            variant="outline"
            onPress={() => {
              const r = recentBtnRef.current?.getBoundingClientRect();
              setRecentAnchor(
                r ? { x: r.left, y: r.bottom + 4 } : { x: 0, y: 0 },
              );
            }}
          >
            Recent
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onPress={() => onRender({ kind: "generic" })}
        >
          Render…
        </Button>
        <span title={IS_EMBEDDED ? "Save (⌘S)" : "Download project"}>
          <Button
            size="sm"
            variant={saveLabel === "Saved" ? "primary" : "outline"}
            onPress={handleSave}
          >
            {IS_EMBEDDED ? saveLabel : "Download"}
          </Button>
        </span>
        {IS_EMBEDDED && (
          <span title="Save As (⇧⌘S)">
            <Button size="sm" variant="outline" onPress={handleSaveAs}>
              Save As&hellip;
            </Button>
          </span>
        )}
      </div>

      {/* Compact dropdown for narrower screens (< xl) */}
      <div className="xl:hidden">
        <Button
          ref={projectDropdownRef}
          size="sm"
          variant="outline"
          className="flex items-center gap-1"
          onPress={() => {
            const r = projectDropdownRef.current?.getBoundingClientRect();
            setProjectMenuAnchor(
              r ? { x: r.left, y: r.bottom + 4 } : { x: 0, y: 0 },
            );
          }}
        >
          <span>Project</span>
          <ChevronDown size={13} className="text-foreground/50" />
        </Button>
      </div>

      {projectMenuAnchor && (
        <ContextMenu
          x={projectMenuAnchor.x}
          y={projectMenuAnchor.y}
          width={190}
          onClose={() => setProjectMenuAnchor(null)}
        >
          <ContextMenuItem
            onClick={() => {
              setProjectMenuAnchor(null);
              handleNew();
            }}
          >
            New Project
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              setProjectMenuAnchor(null);
              handleLoad();
            }}
          >
            {IS_EMBEDDED ? "Load Project…" : "Upload Project…"}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              setProjectMenuAnchor(null);
              onRender({ kind: "generic" });
            }}
          >
            Render…
          </ContextMenuItem>
          <ContextMenuDivider />
          <ContextMenuItem
            onClick={() => {
              setProjectMenuAnchor(null);
              handleSave();
            }}
          >
            {IS_EMBEDDED ? `${saveLabel} (⌘S)` : "Download Project"}
          </ContextMenuItem>
          {IS_EMBEDDED && (
            <ContextMenuItem
              onClick={() => {
                setProjectMenuAnchor(null);
                handleSaveAs();
              }}
            >
              Save As… (⇧⌘S)
            </ContextMenuItem>
          )}
        </ContextMenu>
      )}

      {recentAnchor && (
        <ContextMenu
          x={recentAnchor.x}
          y={recentAnchor.y}
          width={260}
          onClose={() => setRecentAnchor(null)}
        >
          {state.settings.recentProjects.length === 0 ? (
            <ContextMenuItem disabled onClick={() => {}}>
              No Recent Projects
            </ContextMenuItem>
          ) : (
            <>
              {state.settings.recentProjects.map((rp) => (
                <ContextMenuItem
                  key={rp.path}
                  onClick={() => {
                    setRecentAnchor(null);
                    void project.openRecent(rp.path);
                  }}
                >
                  <div className="flex flex-col min-w-0">
                    <span className="font-medium text-xs text-foreground truncate">
                      {rp.displayName}
                    </span>
                    <span
                      className="text-[10px] text-foreground/40 truncate"
                      title={rp.path}
                    >
                      {rp.path}
                    </span>
                  </div>
                </ContextMenuItem>
              ))}
              <ContextMenuDivider />
              <ContextMenuItem
                danger
                onClick={() => {
                  setRecentAnchor(null);
                  void project.clearRecent();
                }}
              >
                Clear Recent
              </ContextMenuItem>
            </>
          )}
        </ContextMenu>
      )}
      <ConfirmDialog
        open={confirmNew}
        title="Unsaved changes"
        message="Start a new project? This discards the current project's unsaved in-memory state (any file already on disk is untouched)."
        confirmLabel="New Project"
        cancelLabel="Cancel"
        danger
        onCancel={() => setConfirmNew(false)}
        onConfirm={() => {
          setConfirmNew(false);
          void project.new();
        }}
      />
    </div>
  );
}
