import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { backup } from "../src/backup.ts";
import { validatePackage } from "../src/package.ts";
import { metadata, mirror, packageBytes, requests, sourceRequests, version } from "./fixtures.ts";
import type { ExpectedRequest } from "./fixtures.ts";

const options = { repository: "owner/archive", token: "test-token", commit: "abc123" };
const api = "https://api.github.com/repos/owner/archive/releases";
const upload = "https://uploads.github.com/repos/owner/archive/releases/1/assets?name=";
const url = "https://github.com/owner/archive/releases/tag/fixture";
const release = { id: 1, tag_name: "fixture", draft: true, html_url: url, assets: [] };

function uploads(bytes: Uint8Array): ExpectedRequest[] {
  return [
    {
      url: `${upload}an.db`, method: "POST", status: 201,
      inspect: init => {
        assert.deepEqual(init.body, Buffer.from(bytes));
        assert.equal((init.headers as Record<string, string>).Authorization, "Bearer test-token");
      },
    },
    {
      url: `${upload}android.ver`, method: "POST", status: 201,
      inspect: init => assert.deepEqual(init.body, Buffer.from(metadata)),
    },
    {
      url: `${upload}manifest.json`, method: "POST", status: 201,
      inspect: init => {
        const manifest = JSON.parse(String(init.body));
        assert.equal(manifest.version, version);
        assert.equal(manifest.sha256, validatePackage(bytes, version));
        assert.equal(manifest.sourceUrl, mirror);
        assert.equal(manifest.bytes, bytes.byteLength);
        assert.ok(Number.isFinite(Date.parse(manifest.retrievedAt)));
      },
    },
  ];
}

test("stages all original assets before publishing a content-addressed release", async () => {
  const bytes = packageBytes();
  const tag = `llt-${version}-${validatePackage(bytes, version)}`;
  const queue = requests([
    ...sourceRequests(bytes),
    { url: `${api}?per_page=100&page=1`, body: "[]" },
    {
      url: api, method: "POST", status: 201,
      body: JSON.stringify({ ...release, html_url: "https://github.com/owner/archive/releases/tag/untagged-draft" }),
      inspect: init => {
        const body = JSON.parse(String(init.body));
        assert.equal(body.draft, true);
        assert.equal(body.tag_name, tag);
        assert.equal(body.target_commitish, options.commit);
      },
    },
    ...uploads(bytes),
    {
      url: `${api}/1`, method: "PATCH", body: JSON.stringify({ ...release, draft: false }),
      inspect: init => assert.deepEqual(JSON.parse(String(init.body)), { draft: false, make_latest: "true" }),
    },
  ]);
  assert.deepEqual(await Effect.runPromise(backup(options, queue.fetcher)), { status: "published", tag, url });
  queue.done();
});

test("downloads unchanged-version packages and skips only an already published checksum", async () => {
  const tags = [];
  for (const bytes of [packageBytes("first revision"), packageBytes("second revision")]) {
    const tag = `llt-${version}-${validatePackage(bytes, version)}`;
    tags.push(tag);
    const queue = requests([
      ...sourceRequests(bytes),
      { url: `${api}?per_page=100&page=1`, body: JSON.stringify([{ ...release, tag_name: tag, draft: false }]) },
    ]);
    assert.equal((await Effect.runPromise(backup(options, queue.fetcher))).status, "unchanged");
    queue.done();
  }
  assert.notEqual(tags[0], tags[1]);
});

test("replaces partial draft assets before completing publication", async () => {
  const bytes = packageBytes();
  const tag = `llt-${version}-${validatePackage(bytes, version)}`;
  const queue = requests([
    ...sourceRequests(bytes),
    {
      url: `${api}?per_page=100&page=1`,
      body: JSON.stringify([{ ...release, tag_name: tag, assets: [{ id: 10, name: "an.db" }] }]),
    },
    { url: `${api}/assets/10`, method: "DELETE", status: 204 },
    ...uploads(bytes),
    { url: `${api}/1`, method: "PATCH", body: JSON.stringify({ ...release, draft: false }) },
  ]);
  assert.equal((await Effect.runPromise(backup(options, queue.fetcher))).status, "published");
  queue.done();
});

test("does not publish when an asset upload fails", async () => {
  const bytes = packageBytes();
  const queue = requests([
    ...sourceRequests(bytes),
    { url: `${api}?per_page=100&page=1`, body: "[]" },
    { url: api, method: "POST", status: 201, body: JSON.stringify(release) },
    { url: `${upload}an.db`, method: "POST", status: 502 },
  ]);
  await assert.rejects(Effect.runPromise(backup(options, queue.fetcher)), /GitHub release request failed/);
  queue.done();
});

test("does not treat a GitHub permission failure as an empty archive", async () => {
  const queue = requests([
    ...sourceRequests(packageBytes()),
    { url: `${api}?per_page=100&page=1`, status: 403 },
  ]);
  await assert.rejects(Effect.runPromise(backup(options, queue.fetcher)), /GitHub release request failed/);
  queue.done();
});

test("finds archived packages beyond the first API page", async () => {
  const bytes = packageBytes();
  const tag = `llt-${version}-${validatePackage(bytes, version)}`;
  const queue = requests([
    ...sourceRequests(bytes),
    {
      url: `${api}?per_page=100&page=1`,
      body: JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ ...release, tag_name: `other-${index}` }))),
    },
    {
      url: `${api}?per_page=100&page=2`,
      body: JSON.stringify([{ ...release, tag_name: tag, draft: false }]),
    },
  ]);
  assert.equal((await Effect.runPromise(backup(options, queue.fetcher))).status, "unchanged");
  queue.done();
});
