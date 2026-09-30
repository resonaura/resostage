import { describe, expect, it } from "vitest";
import type { PluginCatalogEntry } from "../../../../lib/state/api";
import { groupPluginFamilies } from "../logic/pluginFamilies";

function plugin(
  overrides: Partial<PluginCatalogEntry> = {},
): PluginCatalogEntry {
  return {
    id: "acme-eq-vst3",
    name: "Studio EQ VST3",
    manufacturer: "Acme Audio",
    format: "VST3",
    fileOrIdentifier: "Acme Studio EQ.vst3",
    instrument: false,
    enabled: true,
    isNew: false,
    ...overrides,
  };
}

describe("groupPluginFamilies", () => {
  it("groups format variants by normalized manufacturer and name", () => {
    const vst3 = plugin();
    const audioUnit = plugin({
      id: "acme-eq-au",
      name: "Studio EQ Audio Unit",
      format: "AU",
      fileOrIdentifier: "com.acme.studio-eq",
    });

    const families = groupPluginFamilies([vst3, audioUnit]);

    expect(families).toHaveLength(1);
    expect(families[0].variants.map((variant) => variant.format)).toEqual([
      "AU",
      "VST3",
    ]);
  });

  it("promotes a more specific category and sorts families consistently", () => {
    const families = groupPluginFamilies([
      plugin({ name: "Zulu Delay", manufacturer: "Zulu" }),
      plugin({ name: "Studio Synth VST3", category: "Effect" }),
      plugin({
        id: "acme-eq-au",
        name: "Studio Synth Audio Unit",
        format: "AU",
        category: "Fx|EQ",
      }),
    ]);

    expect(families.map((family) => family.name)).toEqual([
      "Studio Synth VST3",
      "Zulu Delay",
    ]);
    expect(families[0].category).toBe("EQ");
  });
});
