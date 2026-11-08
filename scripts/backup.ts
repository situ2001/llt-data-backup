import { Effect } from "effect";
import { backup } from "../src/backup.ts";

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before running the backup`);
  return value;
}

try {
  const result = await Effect.runPromise(backup({
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    token: requiredEnvironment("GH_TOKEN"),
    commit: requiredEnvironment("GITHUB_SHA"),
  }));
  console.log(`${result.status}: ${result.url} (${result.tag})`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
