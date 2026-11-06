import { describe, expect, it } from "vitest";
import { busMinutes, crewStatus, maxDutyMin, snapshotAt, visibilityM } from "../src/server/rules.ts";
import { FOG_AT_HUB } from "../src/server/scenario.ts";

const t = (h: number, m = 0) => h * 60 + m;

describe("duty limits (simplified illustrative table)", () => {
  it("gives 13 h for a morning report and 11 h for a night report", () => {
    expect(maxDutyMin(t(8), 2)).toBe(13 * 60);
    expect(maxDutyMin(t(22), 2)).toBe(11 * 60);
    expect(maxDutyMin(-t(2, 10), 2)).toBe(11 * 60); // 21:50 the evening before
  });

  it("removes 30 min per sector beyond two", () => {
    expect(maxDutyMin(t(8), 4)).toBe(13 * 60 - 60);
  });

  it("flags C07 (FT 721) as caution at 06:42 and illegal after 07:37", () => {
    const c07 = FOG_AT_HUB.crews.find((c) => c.id === "C07")!;
    expect(crewStatus(c07, t(7, 37)).dutyLeftMin).toBe(0);
    expect(crewStatus(c07, t(6, 42)).state).toBe("caution");
    expect(crewStatus(c07, t(7, 40)).state).toBe("illegal");
  });
});

describe("bus times", () => {
  it("is zero for the same airport and null for Bahrain (no road)", () => {
    expect(busMinutes("HUB", "HUB")).toBe(0);
    expect(busMinutes("HUB", "BAH")).toBeNull();
  });

  it("puts Dubai World Central closer to the hub than Sharjah", () => {
    expect(busMinutes("HUB", "DWC")!).toBeLessThan(busMinutes("HUB", "SHJ")!);
    expect(busMinutes("HUB", "DWC")!).toBeGreaterThan(30);
  });
});

describe("snapshot", () => {
  it("closes the hub in fog and reopens after it lifts", () => {
    expect(visibilityM(FOG_AT_HUB, t(5, 40))).toBe(6000);
    expect(snapshotAt(FOG_AT_HUB, t(6, 42)).hubClosed).toBe(true);
    expect(snapshotAt(FOG_AT_HUB, t(9, 35)).hubClosed).toBe(true); // the 08:30 met update moved the lift to 10:45
    expect(snapshotAt(FOG_AT_HUB, t(10, 50)).hubClosed).toBe(false);
    expect(snapshotAt(FOG_AT_HUB, t(8, 0)).fogLifts).toBe(t(9, 30));
    expect(snapshotAt(FOG_AT_HUB, t(8, 30)).fogLifts).toBe(t(10, 45));
  });

  it("counts all 16 diversions and their guests by 06:45", () => {
    const s = snapshotAt(FOG_AT_HUB, t(6, 45));
    expect(s.diverted.reduce((n, d) => n + d.flights.length, 0)).toBe(16);
    expect(s.guestsStuck).toBeGreaterThan(FOG_AT_HUB.flights.reduce((n, f) => n + f.pax, 0));
  });

  it("moves a diverted crew to its diversion airport", () => {
    const s = snapshotAt(FOG_AT_HUB, t(6, 45));
    expect(s.crews.find((c) => c.id === "C01")!.at).toBe("DWC");
    expect(s.crews.find((c) => c.id === "S1")!.at).toBe("HUB");
  });
});
