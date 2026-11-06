import { describe, expect, it } from "vitest";
import { FLY_MIN, SLOT_MIN, returnSchedule } from "../src/server/recovery.ts";
import { buildPlans } from "../src/server/plans.ts";
import { crewStatus, snapshotAt } from "../src/server/rules.ts";
import { FOG_AT_HUB as S } from "../src/server/scenario.ts";

const AT = 6 * 60 + 58;
const [A, B, C] = buildPlans({ snap: snapshotAt(S, AT), scenario: S });
const dutyEnds = (id: string) => crewStatus(S.crews.find((c) => id === c.id)!, 0).dutyEnds;

describe("reopening wave", () => {
  it("lands one aircraft per slot from the reopening, never two in the same slot", () => {
    const r = returnSchedule(S, S.fogLifts, B, AT);
    const lands = r.map((x) => x.land);
    expect(new Set(lands).size).toBe(lands.length);
    expect(Math.min(...lands)).toBe(S.fogLifts);
    expect(lands.every((t) => (t - S.fogLifts) % SLOT_MIN === 0)).toBe(true);
    expect(r.every((x) => x.depart === x.land - FLY_MIN[x.from] && x.depart >= S.fogLifts - 30)).toBe(true);
  });

  it("never lets an original crew land after its duty ends", () => {
    for (const plan of [undefined, A, B, C]) {
      for (const x of returnSchedule(S, S.fogLifts, plan, AT)) if (/^C\d+$/.test(x.crew)) expect(x.land).toBeLessThanOrEqual(dutyEnds(x.crew));
    }
  });

  it("plan B gets the relieved aircraft home early; waiting leaves them for fresh crews after 10:30", () => {
    const b = returnSchedule(S, S.fogLifts, B, AT).find((x) => x.flight === "FT 721")!;
    const none = returnSchedule(S, S.fogLifts, undefined).find((x) => x.flight === "FT 721")!;
    expect(b.crew).toBe("S1");
    expect(none.crew).toBe("fresh crew");
    expect(none.land - b.land).toBeGreaterThan(60);
  });

  it("plan C's cancelled flights stay parked, and guests stuck drain after reopening", () => {
    const r = returnSchedule(S, S.fogLifts, C, AT);
    expect(r.map((x) => x.flight)).not.toContain(C.cancelled![0]);
    const rb = returnSchedule(S, S.fogLifts, B, AT);
    const stuck = (t: number) => snapshotAt(S, t, 1, false, rb).guestsStuck;
    expect(stuck(600)).toBeLessThan(stuck(560));
    expect(stuck(12 * 60 + 40)).toBe(0);
  });
});
