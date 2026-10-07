/** Starting values to calibrate against real learner data, not architectural rules */
export interface Thresholds {
  maxInitialProbes: number;
  maxDetourDepth: number;
  maxReexplanations: number;
  maxDetoursPerChain: number;
  expansionSamples: number;
  /** Half-life in days of confidence in a mastery level, not of the level itself */
  confidenceHalfLifeDays: number;
  reprobeConfidenceFloor: number;
  milestoneFoldForwardRatio: number;
  maxReviewProbesPerAttempt: number;
  maxReviewProbesPerSession: number;
  minDistinctLearnersForPromotion: number;
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
