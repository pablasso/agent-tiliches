import { access, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ReviewRepository, ReviewTarget } from "./types.ts";

interface BrazilPackage {
  name: string;
  path: string;
}

export interface BrazilWorkspaceInfo {
  name: string;
  root: string;
  packages: BrazilPackage[];
}

const BRAZIL_TIMEOUT_MS = 8_000;
const GIT_TIMEOUT_MS = 5_000;

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findGitRoot(pi: ExtensionAPI, cwd: string): Promise<string | null> {
  try {
    const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    if (result.code !== 0 || result.stdout.trim().length === 0) return null;
    return canonicalPath(result.stdout.trim());
  } catch {
    return null;
  }
}

async function findBrazilRoot(cwd: string): Promise<string | null> {
  let current = resolve(cwd);

  while (true) {
    if (await pathExists(join(current, "packageInfo"))) {
      return canonicalPath(current);
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function firstWorkspaceBlock(output: string): string | null {
  const matches = [...output.matchAll(/^[ \t]*Workspace:[ \t]*/gm)];
  const first = matches[0]?.index;
  if (first == null) return null;
  const second = matches[1]?.index ?? output.length;
  return output.slice(first, second);
}

function fieldValue(block: string, field: string): string | null {
  const match = block.match(new RegExp(`^[ \\t]*${field}:[ \\t]*(.+?)[ \\t]*$`, "m"));
  return match?.[1]?.trim() || null;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function parseBrazilWorkspaceInfo(output: string): BrazilWorkspaceInfo | null {
  const block = firstWorkspaceBlock(output);
  if (block == null) return null;

  const name = fieldValue(block, "Workspace");
  const root = fieldValue(block, "Root");
  if (name == null || root == null) return null;

  const packages: BrazilPackage[] = [];
  const packagePattern = /^[ \t]+(\S+)[ \t]+->[ \t]+(.+?)[ \t]*$/gm;
  let match: RegExpExecArray | null;
  while ((match = packagePattern.exec(block)) != null) {
    packages.push({
      name: match[1],
      path: unquote(match[2].trim()),
    });
  }

  return { name, root: unquote(root), packages };
}

async function listWorkspacePackageDirectories(workspaceRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(workspaceRoot, "src"), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => b.length - a.length || a.localeCompare(b));
  } catch {
    return [];
  }
}

function packageDirectoryCandidates(
  workspaceRoot: string,
  packageDirectories: string[],
  pkg: BrazilPackage,
): string[] {
  const candidates: string[] = [];

  for (const directory of packageDirectories) {
    if (pkg.name === directory || pkg.name.startsWith(`${directory}-`)) {
      candidates.push(join(workspaceRoot, "src", directory));
    }
  }

  const withoutVersion = pkg.name.replace(/-\d+(?:\.\d+)*$/, "");
  if (withoutVersion !== pkg.name) {
    candidates.push(join(workspaceRoot, "src", withoutVersion));
  }

  if (isAbsolute(pkg.path)) {
    candidates.push(pkg.path);
  } else {
    candidates.push(join(workspaceRoot, pkg.path));
    candidates.push(join(workspaceRoot, "src", pkg.path));
  }

  return [...new Set(candidates.map((candidate) => resolve(candidate)))];
}

function isWithin(parent: string, child: string): boolean {
  const childRelativePath = relative(parent, child);
  return childRelativePath === "" || (
    childRelativePath !== ".." &&
    !childRelativePath.startsWith(`..${sep}`) &&
    !isAbsolute(childRelativePath)
  );
}

function toWorkspaceRelativePath(workspaceRoot: string, repositoryRoot: string): string {
  const value = relative(workspaceRoot, repositoryRoot) || ".";
  return value.split(sep).join("/");
}

function createRepository(root: string, workspaceRoot = root): ReviewRepository {
  const workspaceRelativePath = toWorkspaceRelativePath(workspaceRoot, root);
  return {
    id: workspaceRelativePath,
    label: basename(root) || root,
    root,
    workspaceRelativePath,
  };
}

async function discoverBrazilRepositories(
  pi: ExtensionAPI,
  workspaceRoot: string,
  packages: BrazilPackage[],
): Promise<ReviewRepository[]> {
  const packageDirectories = await listWorkspacePackageDirectories(workspaceRoot);
  const gitRootCache = new Map<string, Promise<string | null>>();

  const verifyCandidate = (candidate: string): Promise<string | null> => {
    const absoluteCandidate = resolve(candidate);
    let pending = gitRootCache.get(absoluteCandidate);
    if (pending == null) {
      pending = findGitRoot(pi, absoluteCandidate);
      gitRootCache.set(absoluteCandidate, pending);
    }
    return pending;
  };

  const resolved = await Promise.all(packages.map(async (pkg) => {
    const candidates = packageDirectoryCandidates(workspaceRoot, packageDirectories, pkg);
    for (const candidate of candidates) {
      const gitRoot = await verifyCandidate(candidate);
      if (gitRoot != null && isWithin(workspaceRoot, gitRoot)) {
        return { pkg, gitRoot };
      }
    }
    return { pkg, gitRoot: null };
  }));

  const unresolved = resolved.filter((entry) => entry.gitRoot == null).map((entry) => entry.pkg.name);
  if (unresolved.length > 0) {
    throw new Error(`Could not resolve Git repositories for Brazil package(s): ${unresolved.join(", ")}.`);
  }

  const repositoriesByRoot = new Map<string, ReviewRepository>();
  for (const entry of resolved) {
    const gitRoot = entry.gitRoot;
    if (gitRoot == null || repositoriesByRoot.has(gitRoot)) continue;
    repositoriesByRoot.set(gitRoot, createRepository(gitRoot, workspaceRoot));
  }

  return [...repositoriesByRoot.values()].sort((a, b) =>
    a.workspaceRelativePath.localeCompare(b.workspaceRelativePath),
  );
}

export async function discoverReviewTarget(pi: ExtensionAPI, cwd: string): Promise<ReviewTarget> {
  const gitRoot = await findGitRoot(pi, cwd);
  if (gitRoot != null) {
    return {
      kind: "repository",
      root: gitRoot,
      repositories: [createRepository(gitRoot)],
    };
  }

  const discoveredBrazilRoot = await findBrazilRoot(cwd);
  if (discoveredBrazilRoot == null) {
    throw new Error("Not inside a Git repository or Brazil workspace.");
  }

  let result;
  try {
    result = await pi.exec("brazil", ["ws", "show"], {
      cwd: discoveredBrazilRoot,
      timeout: BRAZIL_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Found a Brazil workspace at ${discoveredBrazilRoot}, but \`brazil ws show\` failed: ${message}`);
  }

  if (result.code !== 0 || result.stdout.trim().length === 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`Found a Brazil workspace at ${discoveredBrazilRoot}, but \`brazil ws show\` failed: ${detail}`);
  }

  const info = parseBrazilWorkspaceInfo(result.stdout);
  if (info == null) {
    throw new Error("Could not parse `brazil ws show` output.");
  }

  const reportedRoot = await canonicalPath(info.root);
  if (reportedRoot !== discoveredBrazilRoot) {
    throw new Error(
      `Brazil workspace root mismatch: packageInfo was found at ${discoveredBrazilRoot}, but \`brazil ws show\` reported ${reportedRoot}.`,
    );
  }

  if (info.packages.length === 0) {
    throw new Error(`Brazil workspace ${reportedRoot} contains no packages.`);
  }

  const repositories = await discoverBrazilRepositories(pi, reportedRoot, info.packages);
  if (repositories.length === 0) {
    throw new Error(`Brazil workspace ${reportedRoot} contains no Git repositories.`);
  }

  return {
    kind: "brazil-workspace",
    root: reportedRoot,
    repositories,
  };
}

export function requireSingleReviewRepository(target: ReviewTarget): ReviewRepository {
  if (target.repositories.length === 1) return target.repositories[0];

  const labels = target.repositories.map((repository) => repository.label).join(", ");
  throw new Error(
    `Brazil workspace-wide review discovered ${target.repositories.length} Git repositories (${labels}), ` +
    "but multi-repository aggregation is not implemented yet. Run Pi inside one package repository to review that package.",
  );
}
