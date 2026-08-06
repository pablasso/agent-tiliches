import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getReviewWindowData } from "../extensions/diff-review/git.ts";
import {
  discoverReviewTarget,
  parseBrazilWorkspaceInfo,
  requireSingleReviewRepository,
} from "../extensions/diff-review/target.ts";

const root = await realpath(await mkdtemp(join(tmpdir(), "pi-diff-review-smoke-")));

try {
  const workspace = join(root, "Brazil Workspace");
  const packageRoot = join(workspace, "src", "ExamplePackage");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(workspace, "packageInfo"), "packages = { ExamplePackage-1.0 = .; };\n", "utf8");
  await initializeRepository(packageRoot, true);

  const singleWorkspaceOutput = brazilWorkspaceOutput(workspace, [
    ["ExamplePackage-1.0", "."],
  ]);
  const singleHarness = createPiHarness(new Map([[workspace, singleWorkspaceOutput]]));

  const nestedTarget = await discoverReviewTarget(singleHarness.pi, join(packageRoot, "nested"));
  assert.equal(nestedTarget.kind, "repository");
  assert.equal(nestedTarget.root, packageRoot);
  assert.deepEqual(nestedTarget.repositories, [{
    id: ".",
    label: "ExamplePackage",
    root: packageRoot,
    workspaceRelativePath: ".",
  }]);
  assert.equal(singleHarness.brazilCalls(), 0, "Git discovery must take precedence inside a package repository");

  const workspaceTarget = await discoverReviewTarget(singleHarness.pi, workspace);
  assert.equal(workspaceTarget.kind, "brazil-workspace");
  assert.equal(workspaceTarget.root, workspace);
  assert.deepEqual(workspaceTarget.repositories, [{
    id: "src/ExamplePackage",
    label: "ExamplePackage",
    root: packageRoot,
    workspaceRelativePath: "src/ExamplePackage",
  }]);
  assert.equal(singleHarness.brazilCalls(), 1);

  const reviewData = await getReviewWindowData(singleHarness.pi, workspaceTarget);
  assert.equal(reviewData.target, workspaceTarget);
  assert.equal(reviewData.repoRoot, packageRoot);
  assert.equal(reviewData.files.some((file) => file.path === "tracked.ts" && file.inGitDiff), true);
  assert.equal(reviewData.commits.length, 1);

  const duplicateOutput = `${singleWorkspaceOutput}\n${brazilWorkspaceOutput(join(root, "ignored"), [["Ignored-1.0", "."]])}`;
  assert.deepEqual(parseBrazilWorkspaceInfo(duplicateOutput), {
    name: "test_Brazil_Workspace",
    root: workspace,
    packages: [{ name: "ExamplePackage-1.0", path: "." }],
  });

  const multiWorkspace = join(root, "Multi Workspace");
  const packageA = join(multiWorkspace, "src", "PackageA");
  const packageB = join(multiWorkspace, "src", "PackageB");
  await Promise.all([mkdir(packageA, { recursive: true }), mkdir(packageB, { recursive: true })]);
  await writeFile(
    join(multiWorkspace, "packageInfo"),
    "packages = { PackageA-1.0 = .; PackageB-SDK_2.0.2 = .; };\n",
    "utf8",
  );
  await Promise.all([initializeRepository(packageA), initializeRepository(packageB)]);

  const multiOutput = brazilWorkspaceOutput(multiWorkspace, [
    ["PackageA-1.0", "."],
    ["PackageB-SDK_2.0.2", "."],
  ]);
  const multiHarness = createPiHarness(new Map([[multiWorkspace, multiOutput]]));
  const multiTarget = await discoverReviewTarget(multiHarness.pi, multiWorkspace);
  assert.equal(multiTarget.kind, "brazil-workspace");
  assert.deepEqual(
    multiTarget.repositories.map((repository) => ({
      id: repository.id,
      label: repository.label,
      root: repository.root,
    })),
    [
      { id: "src/PackageA", label: "PackageA", root: packageA },
      { id: "src/PackageB", label: "PackageB", root: packageB },
    ],
  );
  assert.throws(
    () => requireSingleReviewRepository(multiTarget),
    /discovered 2 Git repositories.*multi-repository aggregation is not implemented yet/s,
  );
  await assert.rejects(
    getReviewWindowData(multiHarness.pi, multiTarget),
    /Run Pi inside one package repository/,
  );

  const unrelatedDirectory = join(root, "not-a-project");
  await mkdir(unrelatedDirectory);
  const unrelatedHarness = createPiHarness(new Map());
  await assert.rejects(
    discoverReviewTarget(unrelatedHarness.pi, unrelatedDirectory),
    /Not inside a Git repository or Brazil workspace/,
  );

  assert.equal(parseBrazilWorkspaceInfo("not workspace output"), null);
  console.log("diff-review smoke ok");
} finally {
  await rm(root, { recursive: true, force: true });
}

function brazilWorkspaceOutput(workspaceRoot: string, packages: Array<[string, string]>): string {
  const workspaceName = `test_${basename(workspaceRoot).replaceAll(" ", "_")}`;
  return [
    `Workspace:                ${workspaceName}`,
    `    Root:                 ${workspaceRoot}`,
    "    Version Set:          live@1",
    "    Packages:",
    ...packages.map(([name, path]) => `                          ${name} -> ${path}`),
  ].join("\n");
}

function createPiHarness(workspaceOutputs: Map<string, string>): {
  pi: ExtensionAPI;
  brazilCalls: () => number;
} {
  let calls = 0;

  const pi = {
    async exec(
      command: string,
      args: string[],
      options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
    ) {
      const cwd = options?.cwd ?? process.cwd();
      if (command === "brazil") {
        calls += 1;
        const output = workspaceOutputs.get(cwd);
        return output == null
          ? { stdout: "", stderr: "not a configured Brazil workspace", code: 1, killed: false }
          : { stdout: output, stderr: "", code: 0, killed: false };
      }
      return run(command, args, cwd);
    },
  } as ExtensionAPI;

  return { pi, brazilCalls: () => calls };
}

async function initializeRepository(repositoryRoot: string, dirty = false): Promise<void> {
  await git(repositoryRoot, ["init", "-q"]);
  await git(repositoryRoot, ["config", "user.email", "diff-review@example.test"]);
  await git(repositoryRoot, ["config", "user.name", "Diff Review Smoke"]);
  await writeFile(join(repositoryRoot, "tracked.ts"), "export const value = 1;\n", "utf8");
  await git(repositoryRoot, ["add", "tracked.ts"]);
  await git(repositoryRoot, ["commit", "-qm", "initial"]);
  if (dirty) {
    await writeFile(join(repositoryRoot, "tracked.ts"), "export const value = 2;\n", "utf8");
  }
  await mkdir(join(repositoryRoot, "nested"), { recursive: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await run("git", args, cwd);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
}

async function run(command: string, args: string[], cwd: string) {
  const { spawn } = await import("node:child_process");
  return new Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({
      stdout,
      stderr,
      code: code ?? 1,
      killed: signal != null,
    }));
  });
}
