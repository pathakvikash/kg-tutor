import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@kg/db";
import {
  evaluateClaim, findMissingEdgeCandidates, proposeNewHardEdge, applyProposal,
  reverseProposal, findUnobservedFailureModes, reviewQueueByTraversal, tierFor,
} from "../src/index.js";

const prisma = new PrismaClient();
const FM = "The learner predicts a zero-delay timer runs before the current function returns.";

async function reset() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "PromotionProposal", "Misconception", "EvidenceEvent", "LearnerConceptState",
      "PlanStep", "Plan", "Goal", "Topic", "Edge", "ConceptAlias", "Concept", "Learner"
      RESTART IDENTITY CASCADE`,
  );
}
let n = 0;
const concept = async (name: string) =>
  (await prisma.concept.create({ data: { canonicalName: name, sense: `s${n++}` } })).id;
const learner = async () =>
  (await prisma.learner.create({ data: { email: `e${n++}@x.test` } })).id;

/** N learners attempt `target`; `knew` of them demonstrated `prereq` beforehand. */
async function cohort(opts: {
  prereq: string; target: string; n: number; knew: number;
  failIfIgnorant: number; failIfKnew: number; topicId: string;
}) {
  let t = Date.UTC(2026, 0, 1);
  for (let i = 0; i < opts.n; i++) {
    const l = await learner();
    // Two goals across the cohort, so the diversity requirement can be satisfied.
    await prisma.goal.create({
      data: { learnerId: l, topicId: opts.topicId, depth: i % 2 === 0 ? "use" : "build" },
    });
    const knew = i < opts.knew;
    if (knew) {
      await prisma.evidenceEvent.create({
        data: { learnerId: l, conceptId: opts.prereq, kind: "applied", createdAt: new Date(t) },
      });
    }
    t += 1000;
    const idx = knew ? i : i - opts.knew;
    const shouldFail = knew ? idx < opts.failIfKnew : idx < opts.failIfIgnorant;
    await prisma.evidenceEvent.create({
      data: {
        learnerId: l, conceptId: opts.target,
        kind: shouldFail ? "failed_check" : "applied",
        createdAt: new Date(t),
      },
    });
    t += 1000;
  }
}

beforeEach(reset);
afterAll(async () => { await prisma.$disconnect(); });

describe("evaluateClaim", () => {
  it("passes when ignorance of the prerequisite really predicts failure", async () => {
    const topic = await prisma.topic.create({ data: { name: "js", description: "" } });
    const prereq = await concept("the event loop");
    const target = await concept("promises");
    // 10 knew it and 1 failed; 10 did not and 9 failed.
    await cohort({ prereq, target, n: 20, knew: 10, failIfKnew: 1, failIfIgnorant: 9, topicId: topic.id });

    const claim = await evaluateClaim(prisma, prereq, target);
    expect(claim.controlN).toBe(10);
    expect(claim.treatmentN).toBe(10);
    expect(claim.effectSize).toBeCloseTo(0.8, 5);
    expect(claim.passes).toBe(true);
  });

  it("rejects difficulty masquerading as a prerequisite", async () => {
    const topic = await prisma.topic.create({ data: { name: "js", description: "" } });
    const prereq = await concept("unrelated thing");
    const target = await concept("a genuinely hard concept");
    // Everyone fails a lot, whether or not they know the "prerequisite".
    await cohort({ prereq, target, n: 20, knew: 10, failIfKnew: 8, failIfIgnorant: 9, topicId: topic.id });

    const claim = await evaluateClaim(prisma, prereq, target);
    expect(claim.treatmentFailureRate).toBeGreaterThan(0.8);
    // High failure, but knowing it barely helps — so it is not a prerequisite.
    expect(claim.effectSize).toBeLessThan(0.2);
    expect(claim.passes).toBe(false);
    expect(claim.rejectedFor.join(" ")).toContain("effect size");
  });

  it("refuses to conclude anything with no control arm", async () => {
    const topic = await prisma.topic.create({ data: { name: "js", description: "" } });
    const prereq = await concept("p");
    const target = await concept("t");
    await cohort({ prereq, target, n: 20, knew: 0, failIfKnew: 0, failIfIgnorant: 18, topicId: topic.id });

    const claim = await evaluateClaim(prisma, prereq, target);
    expect(claim.controlN).toBe(0);
    expect(claim.passes).toBe(false);
    expect(claim.rejectedFor.join(" ")).toContain("no control arm");
  });

  it("rejects a strong effect from too few learners", async () => {
    const topic = await prisma.topic.create({ data: { name: "js", description: "" } });
    const prereq = await concept("p");
    const target = await concept("t");
    await cohort({ prereq, target, n: 4, knew: 2, failIfKnew: 0, failIfIgnorant: 2, topicId: topic.id });
    const claim = await evaluateClaim(prisma, prereq, target);
    expect(claim.effectSize).toBeCloseTo(1, 5);
    expect(claim.passes).toBe(false);
    expect(claim.rejectedFor.join(" ")).toContain("distinct learners");
  });
});

describe("proposals", () => {
  async function passingScenario() {
    const topic = await prisma.topic.create({ data: { name: "js", description: "" } });
    const prereq = await concept("the event loop");
    const target = await concept("promises");
    await cohort({ prereq, target, n: 20, knew: 10, failIfKnew: 1, failIfIgnorant: 9, topicId: topic.id });
    for (let i = 0; i < 3; i++) {
      const l = await learner();
      await prisma.evidenceEvent.create({
        data: {
          learnerId: l, conceptId: target, kind: "spontaneous_prerequisite_request",
          referencedConceptId: prereq,
        },
      });
    }
    return { prereq, target };
  }

  it("surfaces an edge learners keep asking for that the graph does not have", async () => {
    const s = await passingScenario();
    const candidates = await findMissingEdgeCandidates(prisma);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      prerequisiteId: s.prereq, targetId: s.target, spontaneousRequests: 3,
    });
  });

  it("does not surface an edge that already exists", async () => {
    const s = await passingScenario();
    await prisma.edge.create({
      data: {
        srcId: s.prereq, dstId: s.target, type: "prerequisite_of",
        strength: "hard", failureMode: FM,
      },
    });
    expect(await findMissingEdgeCandidates(prisma)).toHaveLength(0);
  });

  it("creates a reviewable proposal and writes no edge", async () => {
    const s = await passingScenario();
    const [candidate] = await findMissingEdgeCandidates(prisma);
    const r = await proposeNewHardEdge(prisma, candidate!);
    expect(r.created).toBe(true);
    expect(await prisma.edge.count()).toBe(0);

    const p = await prisma.promotionProposal.findUniqueOrThrow({ where: { id: r.proposalId! } });
    expect(p.status).toBe("open");
    expect(p.claim).toContain("asked about it unprompted");
    expect(p.controlFailureRate).toBeCloseTo(0.1, 5);
  });

  it("does not propose a claim that fails the control test", async () => {
    const topic = await prisma.topic.create({ data: { name: "js", description: "" } });
    const prereq = await concept("p");
    const target = await concept("t");
    await cohort({ prereq, target, n: 20, knew: 10, failIfKnew: 8, failIfIgnorant: 9, topicId: topic.id });
    const r = await proposeNewHardEdge(prisma, {
      prerequisiteId: prereq, targetId: target, spontaneousRequests: 5, misconceptions: 0,
    });
    expect(r.created).toBe(false);
    expect(r.proposalId).toBeNull();
    expect(await prisma.promotionProposal.count()).toBe(0);
  });

  it("writes a provisional, reversible edge on approval", async () => {
    const s = await passingScenario();
    const [candidate] = await findMissingEdgeCandidates(prisma);
    const { proposalId } = await proposeNewHardEdge(prisma, candidate!);

    const { edgeId } = await applyProposal(prisma, proposalId!, "vikash", FM);
    const edge = await prisma.edge.findUniqueOrThrow({ where: { id: edgeId } });
    expect(edge.provisional).toBe(true);
    expect(edge.promotedById).toBe(proposalId);

    const reversed = await reverseProposal(prisma, proposalId!, "effect did not hold");
    expect(reversed.retired).toBe(1);
    // Retired, never deleted — the record of what was believed survives.
    const after = await prisma.edge.findUniqueOrThrow({ where: { id: edgeId } });
    expect(after.retiredAt).not.toBeNull();
    expect(after.retiredReason).toBe("effect did not hold");
  });

  /** A deprecated concept still has a row, so findUniqueOrThrow does not catch this. */
  it("refuses to approve a proposal whose endpoint has since been deprecated", async () => {
    const s = await passingScenario();
    const [candidate] = await findMissingEdgeCandidates(prisma);
    const { proposalId } = await proposeNewHardEdge(prisma, candidate!);
    const proposal = await prisma.promotionProposal.findUniqueOrThrow({ where: { id: proposalId! } });

    await prisma.concept.update({
      where: { id: proposal.srcId! },
      data: { deprecatedAt: new Date() },
    });

    await expect(applyProposal(prisma, proposalId!, "vikash", FM)).rejects.toThrow(/deprecated/);
    // Nothing written, and the proposal is left open rather than half-applied.
    expect(await prisma.edge.count({ where: { promotedById: proposalId } })).toBe(0);
    const after = await prisma.promotionProposal.findUniqueOrThrow({ where: { id: proposalId! } });
    expect(after.status).toBe("open");
    void s;
  });

  it("refuses to approve a proposal whose endpoint has been deleted", async () => {
    const s = await passingScenario();
    const [candidate] = await findMissingEdgeCandidates(prisma);
    const { proposalId } = await proposeNewHardEdge(prisma, candidate!);
    const proposal = await prisma.promotionProposal.findUniqueOrThrow({ where: { id: proposalId! } });

    await prisma.concept.delete({ where: { id: proposal.dstId! } });
    await expect(applyProposal(prisma, proposalId!, "vikash", FM))
      .rejects.toThrow(/no longer exists|can no longer be accepted/);
    void s;
  });

  it("refuses to approve a hard edge with an empty failure mode", async () => {
    const s = await passingScenario();
    const [candidate] = await findMissingEdgeCandidates(prisma);
    const { proposalId } = await proposeNewHardEdge(prisma, candidate!);
    await expect(
      applyProposal(prisma, proposalId!, "vikash", "The learner will not fully understand it."),
    ).rejects.toThrow(/failure mode rejected/);
    expect(await prisma.edge.count()).toBe(0);
  });
});

describe("negative evidence", () => {
  it("flags a failure mode no learner has ever exhibited", async () => {
    const prereq = await concept("p");
    const target = await concept("t");
    const edge = await prisma.edge.create({
      data: {
        srcId: prereq, dstId: target, type: "prerequisite_of", strength: "hard",
        failureMode: FM, createdAt: new Date(Date.UTC(2026, 0, 1)),
      },
    });
    for (let i = 0; i < 35; i++) {
      const l = await learner();
      await prisma.evidenceEvent.create({
        data: {
          learnerId: l, conceptId: target, kind: "applied",
          createdAt: new Date(Date.UTC(2026, 0, 2)),
        },
      });
    }
    const flagged = await findUnobservedFailureModes(prisma, 30);
    expect(flagged.map((f) => f.edgeId)).toContain(edge.id);
  });

  it("does not flag one that learners actually exhibit", async () => {
    const prereq = await concept("p");
    const target = await concept("t");
    await prisma.edge.create({
      data: {
        srcId: prereq, dstId: target, type: "prerequisite_of", strength: "hard",
        failureMode: FM, createdAt: new Date(Date.UTC(2026, 0, 1)),
      },
    });
    for (let i = 0; i < 35; i++) {
      const l = await learner();
      await prisma.evidenceEvent.create({
        data: {
          learnerId: l, conceptId: target, kind: "applied",
          createdAt: new Date(Date.UTC(2026, 0, 2)),
        },
      });
    }
    const l = await learner();
    await prisma.misconception.create({
      data: { learnerId: l, conceptId: target, belief: "b", matchedFailureMode: FM },
    });
    expect(await findUnobservedFailureModes(prisma, 30)).toHaveLength(0);
  });

  it("does not flag an edge with too little traffic to judge", async () => {
    const prereq = await concept("p");
    const target = await concept("t");
    await prisma.edge.create({
      data: { srcId: prereq, dstId: target, type: "prerequisite_of", strength: "hard", failureMode: FM },
    });
    expect(await findUnobservedFailureModes(prisma, 30)).toHaveLength(0);
  });
});

describe("review queue", () => {
  it("puts provisional edges first, then the most-traversed", async () => {
    const a = await concept("a");
    const b = await concept("b");
    const c = await concept("c");
    await prisma.edge.create({
      data: { srcId: a, dstId: b, type: "prerequisite_of", strength: "hard", failureMode: FM },
    });
    await prisma.edge.create({
      data: {
        srcId: a, dstId: c, type: "prerequisite_of", strength: "hard",
        failureMode: FM, provisional: true,
      },
    });
    const q = await reviewQueueByTraversal(prisma);
    expect(q[0]?.provisional).toBe(true);
  });
});

describe("tiering", () => {
  it("automates only what is local and self-correcting", () => {
    expect(tierFor("item_stats")).toBe("auto");
    expect(tierFor("edge_confidence")).toBe("auto");
    expect(tierFor("new_hard_edge")).toBe("review");
    expect(tierFor("remove_edge")).toBe("review");
    expect(tierFor("split_concept")).toBe("review");
  });
});
