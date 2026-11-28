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
const release = { id: 1, tag_name: "fixture", html_url: url, assets: [] };

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

function publication(bytes: Uint8Array): ExpectedRequest[] {
  const tagPrefix = `llt-${version}-${validatePackage(bytes, version)}-`;
  return [
    {
      url: api, method: "POST", status: 201,
      body: JSON.stringify({ ...release, html_url: "https://github.com/owner/archive/releases/tag/untagged-draft" }),
      inspect: init => {
        const body = JSON.parse(String(init.body));
        assert.equal(body.draft, true);
        assert.ok(body.tag_name.startsWith(tagPrefix));
        assert.equal(body.target_commitish, options.commit);
      },
    },
    ...uploads(bytes),
    {
      url: `${api}/1`, method: "PATCH", body: JSON.stringify(release),
      inspect: init => assert.deepEqual(JSON.parse(String(init.body)), { draft: false, make_latest: "true" }),
    },
  ];
}

test("stages all original assets before publishing the first release", async () => {
  const bytes = packageBytes();
  const queue = requests([
    ...sourceRequests(bytes),
    { url: `${api}/latest`, status: 404 },
    ...publication(bytes),
  ]);
  const result = await Effect.runPromise(backup(options, queue.fetcher));
  assert.equal(result.status, "published");
  assert.equal(result.url, url);
  queue.done();
});

function latestPackage(bytes: Uint8Array): ExpectedRequest {
  return {
    url: `${api}/latest`,
    body: JSON.stringify({
      ...release,
      assets: [{ name: "an.db", digest: `sha256:${validatePackage(bytes, version)}` }],
    }),
  };
}

test("skips publication when the package hash matches the latest release", async () => {
  const bytes = packageBytes();
  const queue = requests([...sourceRequests(bytes), latestPackage(bytes)]);
  assert.deepEqual(await Effect.runPromise(backup(options, queue.fetcher)), {
    status: "unchanged", tag: release.tag_name, url,
  });
  queue.done();
});

test("publishes A, B, and A again under distinct tags even with the same publisher version", async () => {
  const first = packageBytes("A");
  const second = packageBytes("B");
  const tags = new Set<string>();
  for (const [bytes, latest] of [
    [first, { url: `${api}/latest`, status: 404 }],
    [second, latestPackage(first)],
    [first, latestPackage(second)],
  ] satisfies [Uint8Array, ExpectedRequest][]) {
    const queue = requests([...sourceRequests(bytes), latest, ...publication(bytes)]);
    const result = await Effect.runPromise(backup(options, queue.fetcher));
    assert.equal(result.status, "published");
    tags.add(result.tag);
    queue.done();
  }
  assert.equal(tags.size, 3);
});

test("does not publish when an asset upload fails", async () => {
  const bytes = packageBytes();
  const queue = requests([
    ...sourceRequests(bytes),
    { url: `${api}/latest`, status: 404 },
    { url: api, method: "POST", status: 201, body: JSON.stringify(release) },
    { url: `${upload}an.db`, method: "POST", status: 502 },
  ]);
  await assert.rejects(Effect.runPromise(backup(options, queue.fetcher)), /GitHub release request failed/);
  queue.done();
});

test("does not treat a GitHub permission failure as an empty archive", async () => {
  const queue = requests([
    ...sourceRequests(packageBytes()),
    { url: `${api}/latest`, status: 403 },
  ]);
  await assert.rejects(Effect.runPromise(backup(options, queue.fetcher)), /GitHub release request failed/);
  queue.done();
});
