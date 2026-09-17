import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowRoot = new URL("../../.github/workflows/", import.meta.url);

async function workflow(name) {
  return readFile(new URL(name, workflowRoot), "utf8");
}

/** Slice one job body out of a workflow: its "  <name>:" header to the next job header. */
function job(source, name) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `job ${name} is missing from the workflow`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Every job that promotes a train: the product release and the five prod lanes. */
const PROMOTION_JOBS = [
  "publish-product-release",
  "deploy-e2b-prod",
  "deploy-server-prod",
  "deploy-workers-prod",
  "deploy-web-prod",
  "deploy-mobile-prod",
];

test("the nightly train runs the artifact-chain gate after the desktop release", async () => {
  const [train, selfhost] = await Promise.all([
    workflow("nightly-release-train.yml"),
    workflow("release-e2e-selfhost.yml"),
  ]);

  // The reusable trigger exists and takes the version under test.
  assert.match(selfhost, /workflow_call:[\s\S]*?release_desktop_version:/);

  const gate = job(train, "release-e2e-gate");
  assert.match(gate, /uses: \.\/\.github\/workflows\/release-e2e-selfhost\.yml/);
  assert.match(gate, /release_desktop_version: \$\{\{ needs\.prepare\.outputs\.desktop_version \}\}/);
  // It verifies the artifact the desktop lane just published, so it waits for it,
  // and it only asserts a desktop version on a train that ships the desktop.
  assert.match(gate, /needs: \[prepare, release-desktop\]/);
  assert.match(gate, /needs\.prepare\.outputs\.desktop == 'true'/);
  assert.match(gate, /needs\.release-desktop\.result == 'success'/);
});

test("the product release and every production promotion require the artifact-chain gate", async () => {
  const train = await workflow("nightly-release-train.yml");

  for (const name of PROMOTION_JOBS) {
    const body = job(train, name);
    assert.match(
      body,
      /needs\.release-e2e-gate\.result == 'success'/,
      `${name} must require the artifact-chain verdict`,
    );
    assert.match(body, /release-e2e-gate/, `${name} must depend on the gate`);
  }

  // The publish job must also wait on the job, not only read its result.
  assert.match(
    job(train, "publish-product-release"),
    /- release-e2e-gate/,
  );
});

test("the train summary reports the artifact-chain verdict", async () => {
  const train = await workflow("nightly-release-train.yml");
  const summary = job(train, "summary");

  assert.match(summary, /- release-e2e-gate/);
  assert.match(summary, /Artifact chain \(T4-SH-2\):/);
  assert.match(summary, /needs\.release-e2e-gate\.result/);
});
