/**
 * Kept as a shim. The real store is learnerStore.ts.
 *
 * This was a useState per call site, which meant the nav badge and the page under it
 * could describe different learners at the same time. Re-exported rather than deleted so
 * the existing call sites migrate one at a time instead of in one risky sweep.
 */
export { useLearner as useStickyLearner, resolveLearner } from "./learnerStore";
