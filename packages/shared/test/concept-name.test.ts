import { describe, it, expect } from "vitest";
import { checkConceptName } from "../src/concept-name.js";

describe("checkConceptName", () => {
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
    ["Memory addresses and address arithmetic", "conjunction"],
  ];
  for (const [name, reason] of observed) {
    it(`rejects ${JSON.stringify(name)} as ${reason}`, () => {
      const r = checkConceptName(name);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(reason);
    });
  }

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
