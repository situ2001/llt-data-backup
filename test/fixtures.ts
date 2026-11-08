import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { VERSION_URL } from "../src/package.ts";

export const version = "20261114";
export const mirror = "http://publisher.test/an.db";
export const metadata = `\uFEFF{"version":{"data":"${version}"},"dataUrl":["${mirror}"],"market":[{"name": 应用宝"}]}`;

export function packageBytes(content = "fixture") {
  const names = [
    "s.i", "t.i", "t.rule", "routes.dat", "extra.dat", "jlb.dat", "sp.dat", "xw.dat", "sn.dat",
    ...Array.from({ length: 10 }, (_, index) => `S${index}.dat`),
    ...Array.from({ length: 20 }, (_, index) => `T${index}.dat`),
  ];
  return zipSync({
    ...Object.fromEntries(names.map(name => [name, strToU8(content)])),
    "ver.txt": strToU8(version),
  });
}

export interface ExpectedRequest {
  url: string | RegExp;
  method?: string;
  status?: number;
  body?: BodyInit;
  inspect?: (init: RequestInit) => void;
}

export function requests(expected: ExpectedRequest[]) {
  let index = 0;
  const fetcher: typeof fetch = async (input, init = {}) => {
    const next = expected[index++];
    assert.ok(next, `Unexpected request ${input}`);
    if (typeof next.url === "string") assert.equal(String(input), next.url);
    else assert.match(String(input), next.url);
    assert.equal(init.method ?? "GET", next.method ?? "GET");
    next.inspect?.(init);
    return new Response(next.body ?? null, { status: next.status ?? 200 });
  };
  return { fetcher, done: () => assert.equal(index, expected.length) };
}

export function sourceRequests(bytes: Uint8Array): ExpectedRequest[] {
  return [
    {
      url: VERSION_URL,
      body: metadata,
      inspect: init => assert.equal(init.headers, undefined),
    },
    {
      url: mirror,
      body: Buffer.from(bytes),
      inspect: init => assert.equal(init.headers, undefined),
    },
  ];
}
