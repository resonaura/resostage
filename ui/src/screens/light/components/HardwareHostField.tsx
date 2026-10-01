// ResoStage — Deterministic Real-Time Live Performance Workstation
// Copyright © 2026 Andrii Vynohradov. All rights reserved.
// Licensed under the GNU General Public License v3.0 or later; see LICENSE.

import { Description, Input, Label, TextField } from "@heroui/react";
import { useState } from "react";
import { lighting } from "@/lib/state/api";
import type { LightFixtureRow } from "@/lib/state/types";
import { CAPTION_CLS } from "@/screens/light/logic/lightStyles";

/** Local-draft host so typing an IP doesn't fight live WS re-renders, and so
 *  a half-typed address is never dialled -- commit lands on blur/Enter only.
 *  Port is always resolight::kDefaultBoardPort on both ends — no UI for it. */
export function HardwareHostField({ fixture }: { fixture: LightFixtureRow }) {
  const [hostDraft, setHostDraft] = useState(fixture.networkHost);
  const [focused, setFocused] = useState(false);

  if (!focused && hostDraft !== fixture.networkHost) {
    setHostDraft(fixture.networkHost);
  }

  const commit = () => {
    setFocused(false);
    const host = hostDraft.trim();
    if (host === fixture.networkHost) return;
    void lighting.fixtureUpdate({ fixtureId: fixture.id, networkHost: host });
  };

  return (
    <TextField
      className="gap-1"
      value={hostDraft}
      onChange={setHostDraft}
      aria-label="Board IP"
    >
      <Label className={CAPTION_CLS}>Board IP</Label>
      <Input
        className="select-text"
        placeholder="e.g. 192.168.1.50"
        onFocus={() => setFocused(true)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      <Description className="text-[10px]">
        Leave empty for preview only (no hardware).
      </Description>
    </TextField>
  );
}
