import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RingBuffer } from "../ring-buffer.js";

describe("RingBuffer", () => {
  describe("constructor", () => {
    it("accepts capacity 1", () => {
      const buf = new RingBuffer<number>(1);
      assert.equal(buf.capacity, 1);
      assert.equal(buf.size, 0);
    });

    it("accepts capacity 3", () => {
      const buf = new RingBuffer<number>(3);
      assert.equal(buf.capacity, 3);
      assert.equal(buf.size, 0);
    });

    it("accepts capacity 100", () => {
      const buf = new RingBuffer<number>(100);
      assert.equal(buf.capacity, 100);
      assert.equal(buf.size, 0);
    });

    it("throws on capacity < 1", () => {
      assert.throws(() => new RingBuffer(0), /capacity must be >= 1/);
      assert.throws(() => new RingBuffer(-1), /capacity must be >= 1/);
    });
  });

  describe("push + toArray", () => {
    it("returns items in insertion order", () => {
      const buf = new RingBuffer<number>(5);
      buf.push(10);
      buf.push(20);
      buf.push(30);
      assert.deepEqual(buf.toArray(), [10, 20, 30]);
    });
  });

  describe("eviction", () => {
    it("evicts oldest when pushed beyond capacity (FIFO)", () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4); // evicts 1
      assert.deepEqual(buf.toArray(), [2, 3, 4]);
    });

    it("evicts multiple oldest entries", () => {
      const buf = new RingBuffer<number>(3);
      for (let i = 1; i <= 6; i++) buf.push(i);
      assert.deepEqual(buf.toArray(), [4, 5, 6]);
    });
  });

  describe("size", () => {
    it("tracks correctly while filling", () => {
      const buf = new RingBuffer<number>(3);
      assert.equal(buf.size, 0);
      buf.push(1);
      assert.equal(buf.size, 1);
      buf.push(2);
      assert.equal(buf.size, 2);
      buf.push(3);
      assert.equal(buf.size, 3);
    });

    it("does not exceed capacity after overflow", () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4);
      buf.push(5);
      assert.equal(buf.size, 3);
    });
  });

  describe("clear", () => {
    it("resets to empty", () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.clear();
      assert.equal(buf.size, 0);
      assert.deepEqual(buf.toArray(), []);
    });

    it("allows pushes after clear", () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.clear();
      buf.push(10);
      assert.equal(buf.size, 1);
      assert.deepEqual(buf.toArray(), [10]);
    });
  });

  describe("capacity 1", () => {
    it("always keeps only the latest item", () => {
      const buf = new RingBuffer<string>(1);
      buf.push("a");
      assert.deepEqual(buf.toArray(), ["a"]);
      buf.push("b");
      assert.deepEqual(buf.toArray(), ["b"]);
      buf.push("c");
      assert.deepEqual(buf.toArray(), ["c"]);
      assert.equal(buf.size, 1);
    });
  });

  describe("toArray", () => {
    it("returns a copy, not a reference to internal storage", () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      const arr1 = buf.toArray();
      const arr2 = buf.toArray();
      assert.deepEqual(arr1, arr2);
      assert.notEqual(arr1, arr2); // different array instances
      arr1.push(999);
      assert.deepEqual(buf.toArray(), [1, 2]); // buffer unaffected
    });

    it("returns empty array for empty buffer", () => {
      const buf = new RingBuffer<number>(5);
      assert.deepEqual(buf.toArray(), []);
    });
  });
});
