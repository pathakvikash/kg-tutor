import { DEFAULT_THRESHOLDS, type Thresholds } from "./config.js";
import { atLeast, type MasteryLevel } from "./index-internal.js";

export interface MilestoneRequirement {
  conceptId: string;
  requiredLevel: MasteryLevel;
}

export interface TrimResult {
  remaining: MilestoneRequirement[];
  satisfied: MilestoneRequirement[];
  foldForward: boolean;
  /** A milestone claiming no concepts is broken, not satisfied */
  malformed: boolean;
}

export function trimMilestone(
  requirements: MilestoneRequirement[],
  current: (conceptId: string) => MasteryLevel,
  t: Thresholds = DEFAULT_THRESHOLDS,
): TrimResult {
  const satisfied: MilestoneRequirement[] = [];
  const remaining: MilestoneRequirement[] = [];
  for (const r of requirements) {
    (atLeast(current(r.conceptId), r.requiredLevel) ? satisfied : remaining).push(r);
  }
  if (requirements.length === 0) {
    return { remaining, satisfied, foldForward: false, malformed: true };
  }
  const ratio = satisfied.length / requirements.length;
  return {
    remaining,
    satisfied,
    foldForward: ratio > t.milestoneFoldForwardRatio,
    malformed: false,
  };
}
