import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("../skills/shadcn/shadcn", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "shadcn-smoke-"));
try {
	const home = join(root, "home with spaces");
	const cwd = join(root, "unrelated project");
	const connector = join(home, ".config", "agent-tiliches", "shadcnio");
	await mkdir(dirname(connector), { recursive: true });
	await mkdir(cwd);

	const run = (args: string[]) => spawnSync(launcher, args, {
		cwd,
		env: { HOME: home, PATH: "/usr/bin:/bin" },
		encoding: "utf8",
		timeout: 5_000,
	});

	let result = run(["tools"]);
	assert.equal(result.status, 127);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /configure an executable/);
	assert(!result.stderr.includes(home), "setup errors should not echo machine-specific paths");

	await writeFile(connector, '#!/bin/sh\nprintf "%s\\n" "$@"\nprintf "%s\\n" "synthetic connector error" >&2\nexit 23\n', { mode: 0o600 });
	assert.equal(run(["tools"]).status, 127, "non-executable configuration must fail clearly");
	await chmod(connector, 0o700);

	const args = ["call", "search_items", "--args", '{"query":"sidebar; $(exit 91) & tabs"}'];
	result = run(args);
	assert.equal(result.status, 23, "connector exit status must propagate");
	assert.equal(result.stdout, `${args.join("\n")}\n`, "arguments must pass through without evaluation or splitting");
	assert.equal(result.stderr, "synthetic connector error\n");
	assert.equal(run([]).stdout, "\n", "no-argument invocation must reach the connector unchanged");

	const skill = await readFile(new URL("../skills/shadcn/SKILL.md", import.meta.url), "utf8");
	assert.match(skill, /^---\nname: shadcn\ndescription: .+\n---\n/);
	assert.match(skill, /\{baseDir\}\/shadcn tools/);
	const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	assert(manifest.pi.skills.includes("./skills"), "the installed package must discover the new skill");

	console.log("shadcn smoke ok");
} finally {
	await rm(root, { recursive: true, force: true });
}
