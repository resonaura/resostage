import { Tooltip } from "@heroui/react";
import {
  Circle,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Square,
} from "lucide-react";
import { Button, ButtonGroup } from "../../../components/ui";
import { transport } from "../../../lib/state/api";

/** Playback and recording actions shared by the Player transport surface. */
export function PlayerTransportButtons({
  playing,
  recording,
}: {
  playing: boolean;
  recording?: boolean;
}) {
  return (
    <ButtonGroup aria-label="Transport">
      {/* `size` is repeated on every button rather than left to the group.
          ButtonGroup shares it by marking its DIRECT children, and these are
          wrapped in Tooltip -- so the mark lands on the tooltip and the buttons
          inside fall back to the default size, which is what made Play stand a
          notch taller than the icons beside it. (The group's own rounding still
          works: Tooltip renders no wrapper element, so the buttons remain its
          first and last DOM children.) */}
      <Tooltip>
        <Button
          size="sm"
          isIconOnly
          variant="default-soft"
          onPress={() => transport.prev()}
          aria-label="Previous"
        >
          <SkipBack size={16} />
        </Button>
        <Tooltip.Content>Previous</Tooltip.Content>
      </Tooltip>
      <Button
        size="sm"
        variant={playing ? "accent-soft" : "default-soft"}
        onPress={() => (playing ? transport.stop() : transport.play())}
        aria-label={playing ? "Pause" : "Play"}
      >
        <ButtonGroup.Separator />
        {playing ? <Pause size={15} /> : <Play size={15} />}
      </Button>
      <Tooltip>
        <Button
          size="sm"
          isIconOnly
          variant="danger-soft"
          onPress={() => void transport.stopToStart()}
          aria-label="Stop"
        >
          <ButtonGroup.Separator />
          <Square size={16} />
        </Button>
        <Tooltip.Content>
          Stop — press again at song start to jump to project start
        </Tooltip.Content>
      </Tooltip>
      <Tooltip>
        <Button
          size="sm"
          isIconOnly
          variant={recording ? "danger" : "default-soft"}
          className={
            recording
              ? "text-danger animate-pulse font-bold"
              : "text-foreground/70 hover:text-danger"
          }
          onPress={() => void transport.record()}
          aria-label={recording ? "Stop Recording" : "Record"}
        >
          <ButtonGroup.Separator />
          <Circle
            size={14}
            className={recording ? "fill-danger" : "fill-current"}
          />
        </Button>
        <Tooltip.Content>
          {recording ? "Stop Recording" : "Record (Audio & MIDI)"}
        </Tooltip.Content>
      </Tooltip>
      <Tooltip>
        <Button
          size="sm"
          isIconOnly
          variant="default-soft"
          onPress={() => transport.next()}
          aria-label="Next"
        >
          <ButtonGroup.Separator />
          <SkipForward size={16} />
        </Button>
        <Tooltip.Content>Next</Tooltip.Content>
      </Tooltip>
    </ButtonGroup>
  );
}
