import { describe, it, expect } from "vitest";
import { checkFailureMode, admissibleStrength } from "../src/index.js";

const names = { sourceName: "the event loop", targetName: "promises" };

describe("failure-mode validation", () => {
  it("accepts a concrete wrong belief", () => {
    expect(
      checkFailureMode(
        "The learner believes setTimeout with a zero delay runs its callback immediately, so they predict the wrong output order.",
        names,
      ).ok,
    ).toBe(true);
  });

  it("rejects assertions that describe no failure", () => {
    for (const vague of [
      "The learner will not fully understand promises without it",
      "They will be confused about how everything fits together",
      "The learner will struggle with the material that follows",
      "It is a necessary prerequisite for the topic that comes next",
    ]) {
      expect(checkFailureMode(vague, names).ok).toBe(false);
    }
  });

  it("rejects a restatement of the prerequisite name", () => {
    expect(checkFailureMode("Without the event loop, the event loop is unclear", names).reason)
      .toBe("circular");
  });

  it("rejects anything too short to describe a failure", () => {
    expect(checkFailureMode("They get confused", names).reason).toBe("too_short");
    expect(checkFailureMode("", names).reason).toBe("too_short");
    expect(checkFailureMode(null, names).reason).toBe("too_short");
  });

  it("demotes to soft rather than dropping the edge", () => {
    expect(admissibleStrength("hard", "vague and short", names)).toBe("soft");
    expect(
      admissibleStrength(
        "hard",
        "The learner writes a chained call expecting the second handler to receive the first handler's argument.",
        names,
      ),
    ).toBe("hard");
    expect(admissibleStrength("soft", null, names)).toBe("soft");
  });
});
