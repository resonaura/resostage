import {
  ContextMenu,
  ContextMenuItem,
} from "../../../components/common/ContextMenu";

/** Single-choice length menu shared by the transport Count-In controls. */
export function CountInContextMenu({
  x,
  y,
  bars,
  onChange,
  onClose,
}: {
  x: number;
  y: number;
  bars: number;
  onChange: (bars: number) => void;
  onClose: () => void;
}) {
  const select = (value: number) => {
    onChange(value);
    onClose();
  };

  return (
    <ContextMenu x={x} y={y} width={164} onClose={onClose}>
      <ContextMenuItem radio checked={bars === 0} onClick={() => select(0)}>
        Count-In Off
      </ContextMenuItem>
      <ContextMenuItem radio checked={bars === 1} onClick={() => select(1)}>
        1 Bar Count-In
      </ContextMenuItem>
      <ContextMenuItem radio checked={bars === 2} onClick={() => select(2)}>
        2 Bars Count-In
      </ContextMenuItem>
    </ContextMenu>
  );
}
