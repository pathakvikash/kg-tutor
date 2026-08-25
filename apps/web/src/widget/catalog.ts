import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

/**
 * The component contract a tutor may target.
 *
 * Deliberately NOT a generic UI kit. Every entry answers a teaching question that prose
 * answers badly: what changes step by step, what two cases look like side by side, what
 * a stack or a queue holds at a given moment. A model given Button and Div builds a
 * form; a model given Timeline and Frames builds an explanation.
 *
 * Keeping this small is the point — it is the vocabulary the model is allowed to think
 * in, and every addition is one more thing it can get wrong.
 */
const step = z.object({
  label: z.string().describe("What happens at this step, in a few words"),
  detail: z.string().optional().describe("One or two sentences of explanation"),
  code: z.string().optional().describe("Code as it stands at this step"),
  highlightLine: z.number().optional().describe("1-based line to highlight"),
});

const option = z.object({
  label: z.string(),
  correct: z.boolean(),
  feedback: z.string().describe("Why this specific choice is right or wrong"),
});

export const catalog = defineCatalog(schema, {
  // No actions: a teaching widget explains, it does not mutate anything outside itself.
  // Interactivity here is local state — stepping a timeline, picking an option.
  actions: {},
  components: {
    Stack: {
      description: "Vertical layout for everything else. Use this as the root element.",
      props: z.object({ gap: z.number().default(12) }),
    },
    Heading: {
      description: "A short label for a section of the widget.",
      props: z.object({ value: z.string() }),
    },
    Text: {
      description: "A paragraph of explanation. Plain text — no markdown, no code.",
      props: z.object({ value: z.string(), muted: z.boolean().default(false) }),
    },
    CodeBlock: {
      description: "Source code. Never put prose in here.",
      props: z.object({
        code: z.string(),
        language: z.string().default("javascript"),
        highlightLine: z.number().default(-1),
      }),
    },
    Timeline: {
      description:
        "Step-by-step execution the learner advances themselves. The most useful " +
        "component for anything about order, sequence or control flow — the event " +
        "loop, the call stack, async ordering, recursion.",
      props: z.object({
        steps: z.array(step),
        stateKey: z.string().default("step").describe("State key holding the current index"),
      }),
    },
    Frames: {
      description:
        "A labelled column of boxes showing a stack or queue at one moment. Bind " +
        "`items` to state with $state so it changes as a Timeline advances. " +
        "orientation 'stack' grows upward (call stack); 'queue' reads left to right.",
      props: z.object({
        title: z.string().default(""),
        items: z.array(z.string()).default([]),
        orientation: z.enum(["stack", "queue"]).default("stack"),
        empty: z.string().default("empty"),
      }),
    },
    Compare: {
      description: "Two labelled panels side by side, showing what changes between two cases.",
      props: z.object({
        leftTitle: z.string(),
        leftCode: z.string(),
        rightTitle: z.string(),
        rightCode: z.string(),
        note: z.string().default(""),
      }),
    },
    Choice: {
      description:
        "An inline question. The learner picks an option and sees the feedback for " +
        "the option they actually chose — not a bare right or wrong.",
      props: z.object({ question: z.string(), options: z.array(option) }),
    },
    Toggle: {
      description:
        "A switch flipping a boolean in state, so other components can show two " +
        "versions of the same thing.",
      props: z.object({
        label: z.string(),
        stateKey: z.string().default("toggled"),
        onText: z.string().default("on"),
        offText: z.string().default("off"),
      }),
    },
  },
});
