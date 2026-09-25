import { describe, it, expect } from "vitest";
import {
  displayCategory,
  displayFormat,
  deduplicatePlugins,
} from "./pluginCategories";

describe("displayCategory", () => {
  it("classifies instruments as Instrument", () => {
    expect(
      displayCategory({
        name: "Analog Synth",
        category: "Synth",
        instrument: true,
      }),
    ).toBe("Instrument");
  });

  it("handles explicit JUCE format categories", () => {
    expect(displayCategory({ name: "MyEQ", category: "Fx|EQ" })).toBe("EQ");
    expect(
      displayCategory({ name: "Limiter", category: "Fx|Dynamics" }),
    ).toBe("Dynamics");
    expect(
      displayCategory({ name: "SpaceEcho", category: "Fx|Delay" }),
    ).toBe("Delay");
    expect(
      displayCategory({ name: "Plate", category: "Fx|Reverb" }),
    ).toBe("Reverb");
  });

  it("classifies AudioUnit effects with fallback name patterns", () => {
    expect(
      displayCategory({ name: "Rev SPRING-636", category: "Effect" }),
    ).toBe("Reverb");
    expect(
      displayCategory({ name: "Comp DIODE-609", category: "Effect" }),
    ).toBe("Dynamics");
    expect(
      displayCategory({ name: "AUDelay", category: "Effect" }),
    ).toBe("Delay");
    expect(
      displayCategory({ name: "BLENDEQ", category: "Effect" }),
    ).toBe("EQ");
    expect(
      displayCategory({ name: "Pro-Q 3", category: "Effect" }),
    ).toBe("EQ");
    expect(
      displayCategory({ name: "Pro-C 2", category: "Effect" }),
    ).toBe("Dynamics");
    expect(
      displayCategory({ name: "Saturn 2", category: "Effect" }),
    ).toBe("Distortion");
    expect(
      displayCategory({ name: "ShaperBox 3", category: "Effect" }),
    ).toBe("Modulation");
  });
});

describe("displayFormat", () => {
  it("converts AudioUnit to AU", () => {
    expect(displayFormat("AudioUnit")).toBe("AU");
  });

  it("preserves VST3 and other formats", () => {
    expect(displayFormat("VST3")).toBe("VST3");
    expect(displayFormat("LV2")).toBe("LV2");
  });
});

describe("deduplicatePlugins", () => {
  it("prefers AudioUnit over VST3 for identical plugin name and vendor", () => {
    const plugins = [
      { id: "vst3-blendeq", name: "BLENDEQ", manufacturer: "AnalogObsession", format: "VST3" },
      { id: "au-blendeq", name: "BLENDEQ", manufacturer: "AnalogObsession", format: "AudioUnit" },
      { id: "vst3-other", name: "OtherEffect", manufacturer: "Vendor", format: "VST3" },
    ];
    const result = deduplicatePlugins(plugins);
    expect(result).toHaveLength(2);
    expect(result.find((p) => p.name === "BLENDEQ")?.id).toBe("au-blendeq");
    expect(result.find((p) => p.name === "OtherEffect")?.id).toBe("vst3-other");
  });

  it("handles case-insensitive and trimmed names and vendors", () => {
    const plugins = [
      { id: "vst3-1", name: " Pro-Q 3 ", manufacturer: "FabFilter", format: "VST3" },
      { id: "au-1", name: "pro-q 3", manufacturer: "fabfilter", format: "AudioUnit" },
    ];
    const result = deduplicatePlugins(plugins);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("au-1");
  });
});
