/*
 * ResoStage — Deterministic Real-Time Live Performance Workstation
 * Copyright © 2026 Andrii Vynohradov. All rights reserved.
 * Licensed under the GNU General Public License v3.0 or later; see LICENSE.
 */

import { describe, expect, it } from "vitest";
import { projectSaveLabel } from "@/project/logic/saveLabel";

describe("project save button status", () => {
  it("reflects only save-specific status, not unrelated project busy work", () => {
    expect(projectSaveLabel("Saving Fixture.rsnraset…")).toBe("Saving…");
    expect(projectSaveLabel("Saved Fixture.rsnraset")).toBe("Saved");
    expect(projectSaveLabel("Importing Song…")).toBe("Save");
    expect(projectSaveLabel("Project operation in progress; retry when it finishes")).toBe("Save");
    expect(projectSaveLabel(undefined)).toBe("Save");
  });
});
