import { test } from "node:test";
import assert from "node:assert/strict";
import { videoDimensions } from "../../supabase/functions/_shared/video-dimensions.ts";

test("reads input width/height from a Stream video object", () => {
  assert.deepEqual(videoDimensions({ input: { width: 1920, height: 1080 } }), { width: 1920, height: 1080 });
  assert.deepEqual(videoDimensions({ input: { width: 1080, height: 1920 } }), { width: 1080, height: 1920 });
});

test("ignores missing, unprobed or nonsense sizes", () => {
  assert.equal(videoDimensions(undefined), null);
  assert.equal(videoDimensions({}), null);
  assert.equal(videoDimensions({ input: { width: -1, height: -1 } }), null);
  assert.equal(videoDimensions({ input: { width: 1920 } }), null);
  assert.equal(videoDimensions({ input: { width: "1920", height: 1080 } }), null);
  assert.equal(videoDimensions({ input: { width: 1920.5, height: 1080 } }), null);
  assert.equal(videoDimensions({ input: { width: 99999, height: 1080 } }), null);
});
