import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Effect } from "effect";
import { strToU8, unzipSync, zipSync } from "fflate";
import { fetchPackage, parseVersionDocument, validatePackage, VERSION_URL } from "../src/package.ts";
import { metadata, mirror, packageBytes, requests, version } from "./fixtures.ts";

test("reads version and mirrors despite the publisher's malformed market section", () => {
  assert.deepEqual(parseVersionDocument(metadata), { version, mirrors: [mirror] });
  assert.throws(() => parseVersionDocument('{"version":{"data":42},"dataUrl":[]}'));
  assert.throws(() => parseVersionDocument(`{"version":{"data":"${version}"},"dataUrl":["file:///an.db"]}`));
});

test("validates archive members and internal version before hashing original bytes", () => {
  const bytes = packageBytes();
  assert.equal(validatePackage(bytes, version), createHash("sha256").update(bytes).digest("hex"));
  assert.throws(() => validatePackage(bytes, "20261001"), /ver.txt/);
  const members = unzipSync(bytes);
  delete members["T19.dat"];
  assert.throws(() => validatePackage(zipSync(members), version), /T19.dat/);
  assert.throws(() => validatePackage(strToU8("not an archive"), version));
});

test("uses the next advertised mirror when a package is invalid", async () => {
  const second = "http://second.test/an.db";
  const bytes = packageBytes();
  const queue = requests([
    { url: VERSION_URL, body: metadata.replace(`["${mirror}"]`, `["${mirror}","${second}"]`) },
    { url: mirror, body: "not an archive" },
    { url: second, body: Buffer.from(bytes) },
  ]);
  const result = await Effect.runPromise(fetchPackage(queue.fetcher));
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.manifest.sourceUrl, second);
  queue.done();
});

test("fails when every mirror is invalid", async () => {
  const queue = requests([
    { url: VERSION_URL, body: metadata },
    { url: mirror, status: 503 },
  ]);
  await assert.rejects(Effect.runPromise(fetchPackage(queue.fetcher)), /No valid Lulutong package mirror/);
  queue.done();
});
