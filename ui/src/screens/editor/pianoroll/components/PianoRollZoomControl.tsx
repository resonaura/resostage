import { MoveHorizontalIcon, MoveVerticalIcon } from "lucide-react";
import { Slider } from "../../../../components/ui";

interface PianoRollZoomControlProps {
  pixelsPerBeat: number;
  onPixelsPerBeatChange: (value: number) => void;
  pixelsPerPitch: number;
  onPixelsPerPitchChange: (value: number) => void;
}

export function PianoRollZoomControl({
  pixelsPerBeat,
  onPixelsPerBeatChange,
  pixelsPerPitch,
  onPixelsPerPitchChange,
}: PianoRollZoomControlProps) {
  return (
    <div className="flex w-52 shrink-0 items-center gap-1.5 border-l border-default/30 pl-2">
      <MoveHorizontalIcon
        style={{ opacity: 0.4, width: "14px", height: "14px" }}
      />
      <div className="flex-1 min-w-0 flex items-center">
        <Slider
          aria-label="Horizontal zoom"
          minValue={0}
          maxValue={1}
          step={0.001}
          value={Math.max(
            0,
            Math.min(1, Math.log(pixelsPerBeat / 20) / Math.log(400 / 20)),
          )}
          onChange={(value) => {
            const normalized = Array.isArray(value) ? value[0] : value;
            const next = 20 * Math.pow(400 / 20, normalized);
            onPixelsPerBeatChange(next);
          }}
          className="min-w-0 flex-1 flex items-center justify-center"
        >
          <Slider.Track>
            <Slider.Fill />
            <Slider.Thumb />
          </Slider.Track>
        </Slider>
      </div>
      <MoveVerticalIcon
        style={{ opacity: 0.4, width: "14px", height: "14px" }}
      />
      <div className="flex-1 min-w-0 flex items-center">
        <Slider
          aria-label="Vertical zoom"
          minValue={10}
          maxValue={40}
          step={0.5}
          value={pixelsPerPitch}
          onChange={(value) => {
            const next = Array.isArray(value) ? value[0] : value;
            onPixelsPerPitchChange(next);
          }}
          className="min-w-0 flex-1 flex items-center justify-center"
        >
          <Slider.Track>
            <Slider.Fill />
            <Slider.Thumb />
          </Slider.Track>
        </Slider>
      </div>
    </div>
  );
}
