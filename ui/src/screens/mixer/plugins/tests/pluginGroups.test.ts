import { describe, expect, it } from "vitest";
import type { PluginCatalogEntry } from "../../../../lib/state/api";
import { groupEffects, groupInstruments } from "../logic/pluginGroups";

const plugin = (
  partial: Partial<PluginCatalogEntry> & Pick<PluginCatalogEntry, "id" | "name">,
): PluginCatalogEntry => ({
  manufacturer: "",
  format: "VST3",
  fileOrIdentifier: "",
  instrument: false,
  enabled: true,
  isNew: false,
  ...partial,
});

describe("plugin groups", () => {
  it("groups enabled instruments by vendor and sorts groups and entries", () => {
    const groups = groupInstruments([
      plugin({ id: "z", name: "Zeta", manufacturer: "Acme", instrument: true }),
      plugin({ id: "a", name: "Alpha", manufacturer: "Acme", instrument: true }),
      plugin({ id: "keys", name: "Keys", category: "Keyboard", instrument: true }),
      plugin({ id: "unknown", name: "Unknown", instrument: true, category: undefined }),
      plugin({ id: "disabled", name: "Disabled", instrument: true, enabled: false }),
      plugin({ id: "effect", name: "Effect", instrument: false }),
    ]);

    expect(groups.map(({ name }) => name)).toEqual([
      "Acme",
      "Instruments",
      "Keyboard",
    ]);
    expect(groups[0].plugins.map(({ name }) => name)).toEqual(["Alpha", "Zeta"]);
  });

  it("groups only audio effects by display category", () => {
    const groups = groupEffects([
      plugin({ id: "eq", name: "Equalizer", category: "Fx|EQ" }),
      plugin({ id: "comp", name: "Compressor", category: "Fx|Dynamics" }),
      plugin({ id: "inst", name: "Synth", instrument: true }),
      plugin({ id: "no-audio", name: "Generator", inputs: 0 }),
      plugin({ id: "unknown-io", name: "Analyzer", inputs: undefined }),
    ]);

    expect(groups.map(({ name }) => name)).toEqual([
      "Dynamics",
      "EQ",
      "Utility",
    ]);
    expect(groups.flatMap((group) => group.plugins.map(({ id }) => id))).toEqual([
      "comp",
      "eq",
      "unknown-io",
    ]);
  });
});
