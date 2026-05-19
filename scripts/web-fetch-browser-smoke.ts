import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { runWebFetch } from "../extensions/web-fetch/core.ts";

const html = `<!doctype html>
<html>
<head><title>Browser Smoke Test</title></head>
<body>
  <nav><button aria-expanded="false" aria-controls="nav-panel">Jobs</button><div id="nav-panel" hidden>Navigation panel should stay out.</div></nav>
  <main>
    <h1>Browser Rendered Page</h1>
    <p>Visible browser-mode paragraph.</p>
    <button id="toggle" aria-expanded="false" aria-controls="panel">Show more</button>
    <div id="panel" hidden>Browser-only expanded answer.</div>
  </main>
  <script>
    document.getElementById('toggle').addEventListener('click', () => {
      document.getElementById('panel').hidden = false;
      document.getElementById('toggle').setAttribute('aria-expanded', 'true');
    });
  </script>
</body>
</html>`;

const server = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end(html);
});

const baseUrl = await listen(server);
try {
	const result = await runWebFetch({ url: baseUrl, mode: "browser", format: "markdown", scope: "main" }, { timeoutMs: 10_000 });
	assert.equal(result.details.mode, "browser");
	assert.match(result.details.extraction, /^browser-(readability|cleaned)$/);
	assert.match(result.output, /# Browser Rendered Page/);
	assert.match(result.output, /Visible browser-mode paragraph/);
	assert.match(result.output, /Browser-only expanded answer/);
	assert.doesNotMatch(result.output, /Navigation panel/);
	assert.match(result.details.browser?.engine ?? "", /^(chromium|chrome)$/);
	assert.equal(result.details.browser?.controlsClicked, 1);
	console.log("web-fetch browser smoke ok");
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
