import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { runWebFetch } from "../extensions/web-fetch/core.ts";

const html = `<!doctype html>
<html>
<head>
  <title>Smoke Test Page</title>
  <base href="https://example.test/docs/">
</head>
<body>
  <nav>Navigation junk should not appear</nav>
  <main>
    <h1>Main Title</h1>
    <p>Visible paragraph with <a href="guide.html">relative link</a>.</p>
    <details><summary>Folded Question</summary><p>Folded Answer</p></details>
    <section aria-expanded="false" aria-controls="panel-1"><button>Show more</button></section>
    <div id="panel-1" hidden>Hidden Secret</div>
  </main>
</body>
</html>`;

const server = createServer((req, res) => {
	if (req.url === "/slow") {
		res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
		res.write("start\n");
		setTimeout(() => res.end("end\n"), 500);
		return;
	}

	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end(html);
});

const baseUrl = await listen(server);
try {
	const result = await runWebFetch({ url: baseUrl, format: "markdown", scope: "main" });
	assert.equal(result.details.status, 200);
	assert.equal(result.details.title, "Smoke Test Page");
	assert.match(result.output, /# Main Title/);
	assert.match(result.output, /Visible paragraph/);
	assert.match(result.output, /\[relative link\]\(https:\/\/example\.test\/docs\/guide\.html\)/);
	assert.match(result.output, /Folded Answer/);
	assert.doesNotMatch(result.output, /Navigation junk/);
	assert.doesNotMatch(result.output, /Hidden Secret/);
	assert.equal(result.details.foldables.detected, 4);
	assert.equal(result.details.foldables.included, 1);
	assert.equal(result.details.foldables.ignored, 3);
	assert.equal(result.details.hidden.detected, 1);
	assert.equal(result.details.hidden.included, 0);

	const noFoldables = await runWebFetch({ url: baseUrl, format: "markdown", scope: "main", foldables: "ignore" });
	assert.doesNotMatch(noFoldables.output, /Folded Answer/);
	assert.equal(noFoldables.details.foldables.included, 0);

	let timedOut = false;
	try {
		await runWebFetch({ url: new URL("slow", baseUrl).toString(), format: "text" }, { timeoutMs: 50 });
	} catch (error) {
		timedOut = error instanceof Error && /Timed out after 50ms/.test(error.message);
	}
	assert.equal(timedOut, true, "body read timeout should abort slow responses");

	console.log("web-fetch smoke ok");
} finally {
	await close(server);
}

function listen(server: Server): Promise<string> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			const address = server.address();
			assert(address && typeof address === "object");
			resolve(`http://127.0.0.1:${address.port}/`);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}
