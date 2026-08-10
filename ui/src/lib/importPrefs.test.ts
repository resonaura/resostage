// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  overrunsSong,
  readLongImportPreference,
  writeLongImportPreference,
} from "./importPrefs";

describe("long import preference", () => {
  beforeEach(() => localStorage.clear());

  it("asks until told otherwise", () => {
    expect(readLongImportPreference()).toBe("ask");
  });

  it("round-trips a remembered choice", () => {
    writeLongImportPreference("extend");
    expect(readLongImportPreference()).toBe("extend");
    writeLongImportPreference("ask");
    expect(readLongImportPreference()).toBe("ask");
  });

  it("ignores a value it does not recognise", () => {
    localStorage.setItem("resostage.import.longRegion", "explode");
    expect(readLongImportPreference()).toBe("ask");
  });
});

describe("overrunsSong", () => {
  it("says nothing when the song length is derived", () => {
    // endSeconds 0 = derive from content, so content cannot overrun it.
    expect(overrunsSong(300, 0)).toBe(false);
  });

  it("catches a region running past an authored end", () => {
    expect(overrunsSong(240, 180)).toBe(true);
  });

  it("lets a rounding difference through", () => {
    expect(overrunsSong(180.02, 180)).toBe(false);
    expect(overrunsSong(180.5, 180)).toBe(true);
  });

  it("is quiet when the region fits", () => {
    expect(overrunsSong(120, 180)).toBe(false);
  });
});
