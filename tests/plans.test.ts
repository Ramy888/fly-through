import { describe, expect, it } from "vitest";
import { buildPlans, decisionState, planOption } from "../src/server/plans.ts";
import { snapshotAt } from "../src/server/rules.ts";
import { FOG_AT_HUB } from "../src/server/scenario.ts";

const at = (h: number, m: number) => snapshotAt(FOG_AT_HUB, h * 60 + m);
const plans = buildPlans({ snap: at(6, 58), scenario: FOG_AT_HUB });
const byId = Object.fromEntries(plans.map((p) => [p.id, p]));

describe("recovery plans (computed in code)", () => {
  it("offers A wait, B bus standbys, C cancel", () => {
    expect(plans.map(planOption)).toEqual(["A: Wait for the fog to lift", "B: Bus standby crews now", "C: Cancel 4 flights"]);
  });

  it("buses the three standby crews to the crews at risk by road, tightest first, and skips Bahrain (no road)", () => {
    expect(byId.B.buses!.map((b) => [b.crew, b.replaces, b.to])).toEqual([
      ["S1", "C07", "DWC"],
      ["S2", "C15", "DWC"],
      ["S3", "C10", "SHJ"],
    ]);
    expect(byId.B.buses!.every((b) => b.minutes > 30)).toBe(true);
  });

  it("keeps more crews legal and protects more guests with B than with A", () => {
    expect(byId.B.metrics.crewsKeptLegal).toBe(byId.A.metrics.crewsKeptLegal + 3);
    expect(byId.B.metrics.guestsProtected).toBeGreaterThan(byId.A.metrics.guestsProtected);
    expect(byId.B.metrics.costAed).toBeLessThan(byId.A.metrics.costAed);
  });

  it("makes cancelling the most expensive option", () => {
    expect(byId.C.metrics.costAed).toBeGreaterThan(byId.A.metrics.costAed);
  });

  it("gives the decision model computed facts, not model guesses", () => {
    const s = decisionState({ snap: at(6, 58), scenario: FOG_AT_HUB }, plans);
    expect(s).toContain("C07 at DWC (out of hours at 07:37)");
    expect(s).toContain(`crews kept legal ${byId.B.metrics.crewsKeptLegal}/`);
  });
});
