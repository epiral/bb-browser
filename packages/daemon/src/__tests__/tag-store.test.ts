import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";

async function loadTagStore(testHome: string) {
  process.env.BB_BROWSER_HOME = testHome;
  return import(`../tag-store.ts?test=${Date.now()}-${Math.random()}`);
}

describe("tag store", () => {
  let testHome = "";

  afterEach(async () => {
    if (testHome) {
      await rm(testHome, { recursive: true, force: true });
    }
  });

  it("persists tags per domain", async () => {
    testHome = path.join(os.tmpdir(), `bb-browser-tags-${process.pid}-${Date.now()}`);
    const store = await loadTagStore(testHome);

    const record = {
      name: "searchBox",
      domain: "example.com",
      mode: "single" as const,
      fingerprint: {
        tagName: "input",
        placeholder: "Search",
        xpath: "/html[1]/body[1]/input[1]",
      },
      createdAt: "2026-04-08T00:00:00.000Z",
      updatedAt: "2026-04-08T00:00:00.000Z",
    };

    store.setTag(record);

    assert.deepEqual(store.getTag("example.com", "searchBox"), record);
    assert.equal(store.listTags("example.com").length, 1);
    assert.equal(store.listTags("other.com").length, 0);
  });

  it("removes tags and cleans up empty domains", async () => {
    testHome = path.join(os.tmpdir(), `bb-browser-tags-${process.pid}-${Date.now()}-remove`);
    const store = await loadTagStore(testHome);

    store.setTag({
      name: "resultItems",
      domain: "example.com",
      mode: "list",
      fingerprint: {
        tagName: "li",
        parentXPath: "/html[1]/body[1]/ul[1]",
      },
      createdAt: "2026-04-08T00:00:00.000Z",
      updatedAt: "2026-04-08T00:00:00.000Z",
    });

    assert.equal(store.removeTag("example.com", "resultItems"), true);
    assert.equal(store.getTag("example.com", "resultItems"), null);
    assert.equal(store.removeTag("example.com", "resultItems"), false);
  });
});
