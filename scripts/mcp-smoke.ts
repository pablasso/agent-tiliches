import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const config = JSON.parse(await readFile(new URL("../config/mcp.example.json", import.meta.url), "utf8"));
assert.deepEqual(Object.keys(config.mcpServers).sort(), ["linear", "shadcnio"]);
const { shadcnio, linear } = config.mcpServers;
assert.equal(shadcnio.url, "https://www.shadcn.io/api/mcp");
assert.equal(linear.url, "https://mcp.linear.app/mcp");
for (const server of [shadcnio, linear]) {
	const url = new URL(server.url);
	assert.equal(url.protocol, "https:");
	assert.equal(url.search, "", "credentials must not be in endpoint URLs");
	assert.equal(url.username + url.password, "");
	assert.equal(server.command, undefined, "use native HTTP, not an external bridge");
	assert(server.description);
}

const reviewedTools = [
	"search_items", "list_items", "list_block_categories", "list_blocks_in_category",
	"get_item", "get_item_source", "search_icons", "list_tools", "get_item_details",
	"get_preview_url", "whoami", "list_popular", "get_registry_stats",
];
assert.equal(shadcnio.exposure, "hidden", "deny new tools and resource access by default");
assert.deepEqual(Object.keys(shadcnio.toolExposure).sort(), reviewedTools.sort());
assert(Object.values(shadcnio.toolExposure).every(exposure => exposure === "codemode"));
assert(Object.keys(shadcnio.toolExposure).every(name => !name.includes("*")));
for (const name of ["get_install_command", "get_icon", "future_tool"]) {
	assert.equal(shadcnio.toolExposure[name] ?? shadcnio.exposure, "hidden");
}
assert.equal(shadcnio.oauth, undefined, "shadcn.io uses a static bearer credential");
assert.deepEqual(Object.keys(shadcnio.headers), ["Authorization"]);
assert(shadcnio.headers.Authorization.startsWith("!"));
assert(!JSON.stringify(config).includes("/Users/"), "examples must not contain private machine paths");
assert.equal(linear.exposure, "codemode");
assert.deepEqual(linear.oauth, { scope: "read write" });
assert.equal(linear.headers, undefined, "Linear needs native OAuth refresh, not a static token header");

// Exercise Pi's configured shell-command boundary with synthetic credentials only.
// Never resolve the real user's header or contact either service in this test.
const root = await mkdtemp(join(tmpdir(), "mcp-smoke-"));
try {
	const home = join(root, "home with spaces");
	const cwd = join(root, "unrelated project");
	const tokenPath = join(home, ".pi", "agent", "mcp-secrets", "shadcnio-token");
	await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
	await mkdir(cwd);
	for (const token of ["SYNTHETIC_NOT_A_REAL_CREDENTIAL", "synthetic; $(exit 91) & 'quotes'"]) {
		await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
		const result = spawnSync("/bin/sh", ["-c", shadcnio.headers.Authorization.slice(1)], {
			cwd,
			env: { HOME: home, PATH: "/usr/bin:/bin" },
			encoding: "utf8",
			timeout: 5_000,
		});
		assert.equal(result.status, 0);
		assert.equal(result.stderr, "");
		assert.equal(result.stdout, `Bearer ${token}`, "file contents must not be evaluated as shell code");
	}
	await rm(tokenPath);
	const missing = spawnSync("/bin/sh", ["-c", shadcnio.headers.Authorization.slice(1)], {
		cwd, env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5_000,
	});
	assert.notEqual(missing.status, 0, "missing credentials must fail, not return a blank bearer header");
	assert.equal(missing.stdout, "");
} finally {
	await rm(root, { recursive: true, force: true });
}

const shadcn = await readFile(new URL("../skills/shadcn/SKILL.md", import.meta.url), "utf8");
const linearSkill = await readFile(new URL("../skills/linear/SKILL.md", import.meta.url), "utf8");
for (const [name, skill] of [["shadcn", shadcn], ["linear", linearSkill]]) {
	assert.match(skill, new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n`));
	assert.match(skill, /describeTool/);
	assert.match(skill, /isError/);
	assert.match(skill, /\.\.\/\.\.\/docs\/mcp\.md/);
	assert.doesNotMatch(skill, /mcporter|\{baseDir\}\/shadcn|\.config\/agent-tiliches\/shadcnio/i);
}
assert.match(shadcn, /get_install_command.*get_icon/);
assert.match(shadcn, /does \*\*not\*\* generically redact/);
assert.match(shadcn, /premium: true/);
assert.match(linearSkill, /Ask for explicit confirmation and wait for the user's reply/);
assert.match(linearSkill, /not a technical sandbox or enforced/);
assert.match(linearSkill, /no default team, project, assignee, cycle, or status/);
assert.match(linearSkill, /Never create test data/);
assert.match(linearSkill, /pi mcp login linear/);
assert.match(linearSkill, /Never request `admin`/);
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert(manifest.pi.skills.includes("./skills"));
assert(!Object.keys(manifest.dependencies).some(name => /mcporter|mcp-adapter/.test(name)));
await assert.rejects(access(new URL("../skills/shadcn/shadcn", import.meta.url)), { code: "ENOENT" });
console.log("native MCP smoke ok (offline; synthetic credentials only)");
