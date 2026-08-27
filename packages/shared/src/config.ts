/** Starting values to calibrate against real learner data, not architectural rules. (policy A) */
export interface Thresholds {
  /** Hard cap on the initial assessment. Stop even if uncertainty remains. (07) */
  maxInitialProbes: number;
  /** Prerequisite levels one detour may descend before the concept is blocked. (10) */
  maxDetourDepth: number;
  /** Re-explanations of the same concept before moving on. (10) */
  maxReexplanations: number;
  /** Detours per chain per session. (10) */
  maxDetoursPerChain: number;
  /** Independent samples per expansion; majority survives. (15) */
  expansionSamples: number;
  /** Confidence half-life in days — decays mastery's trustworthiness, not mastery. (06) */
  confidenceHalfLifeDays: number;
  /** Below this, a concept on the path is re-probed rather than assumed. (06) */
  reprobeConfidenceFloor: number;
  /** Fold a milestone forward when this fraction is already satisfied. (18) */
  milestoneFoldForwardRatio: number;
  /** Review probes per concept attempt, and per session. (20) */
  maxReviewProbesPerAttempt: number;
  maxReviewProbesPerSession: number;
  /** Distinct learners required before a structural claim can be reviewed. (11) */
  minDistinctLearnersForPromotion: number;
  /** Distinct goals required, so one cohort's quirk is not universal truth. (11) */
  minDistinctGoalsForPromotion: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  maxInitialProbes: 8,
  maxDetourDepth: 2,
  maxReexplanations: 2,
  maxDetoursPerChain: 1,
  expansionSamples: 3,
  confidenceHalfLifeDays: 45,
  reprobeConfidenceFloor: 0.4,
  milestoneFoldForwardRatio: 2 / 3,
  maxReviewProbesPerAttempt: 1,
  maxReviewProbesPerSession: 2,
  minDistinctLearnersForPromotion: 12,
  minDistinctGoalsForPromotion: 2,
};
