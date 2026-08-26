import { describe, it, expect } from "vitest";
import { checkConceptName } from "../src/concept-name.js";

describe("checkConceptName", () => {
  /** Every one of these was written into the graph by a real expansion. */
  const observed: [string, string][] = [
    ["Arrays or Linked Lists", "disjunction"],
    ["Recursion or iterative traversal", "disjunction"],
    ["Hash Functions and Hash Tables", "conjunction"],
    ["Pointers/References and Memory Allocation", "conjunction"],
    ["Variables and memory allocation", "conjunction"],
    ["Big-O / Amortized Analysis", "conjunction"],
    ["Graph terminology (vertices, edges, directed/undirected, weighted)", "parenthetical"],
    ["Graph connectivity concepts", "meta_noun"],
    ["LIFO (Last-In-First-Out) ordering concept", "meta_noun"],
    // Listed as acceptable on a first pass, and it is not: "memory addresses" and
    // "address arithmetic" are two things, joined. It is also step one of the real
    // Data Structures plan, so the first thing that graph teaches is a compound.
    ["Memory addresses and address arithmetic", "conjunction"],
  ];
  for (const [name, reason] of observed) {
    it(`rejects ${JSON.stringify(name)} as ${reason}`, () => {
      const r = checkConceptName(name);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(reason);
    });
  }

  /** The other 28 from the same expansion were fine and must stay fine. */
  const good = [
    "Array", "Dynamic Array", "Static Arrays", "Binary Search Tree", "Binary Heap",
    "Hash Function", "Hash Table", "Hash Collision Resolution", "Linked List",
    "Doubly Linked List", "Singly Linked List", "Priority Queue", "Deque", "Trie",
    "Queue", "Stack", "Trees", "Binary Tree", "Recursion", "Big-O Notation",
    "Amortized Analysis", "Modular Arithmetic", "Comparison-based Ordering",
    "Dynamic Memory Allocation", "Graph Representation",
  ];
  for (const name of good) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      expect(checkConceptName(name).ok).toBe(true);
    });
  }

  it("treats a slash between single words as a synonym, not a join", () => {
    expect(checkConceptName("Pointers/References").ok).toBe(true);
  });

  it("keeps a parenthesised synonym that is not a list", () => {
    expect(checkConceptName("Disjoint Set (Union-Find)").ok).toBe(true);
  });

  it("offers the halves so a caller can propose them separately", () => {
    expect(checkConceptName("Hash Functions and Hash Tables").parts)
      .toEqual(["Hash Functions", "Hash Tables"]);
  });

  it("rejects a sentence masquerading as a name", () => {
    expect(checkConceptName("how a hash function maps keys to array indices and buckets").ok)
      .toBe(false);
  });

  it("rejects empty", () => {
    expect(checkConceptName("   ").reason).toBe("empty");
  });
});
