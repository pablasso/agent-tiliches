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

const articleHtml = `<!doctype html>
<html>
<head><title>Readable Test</title></head>
<body>
  <nav>Article navigation junk should not appear</nav>
  <article>
    <h1>Readable Article</h1>
    <p>This is a substantial paragraph about web fetching and readable extraction. It has enough text for Mozilla Readability to identify it as main article content rather than page chrome.</p>
    <p>Another paragraph provides more natural article content with useful information, links, and enough words to pass the extraction threshold in the smoke test.</p>
    <p>Final paragraph confirms that the article body is preserved and navigation is excluded from the Markdown output.</p>
  </article>
</body>
</html>`;

const scopedHtml = `<!doctype html>
<html>
<head><title>Scope Test</title></head>
<body>
  <main>
    <h1>Main Content</h1>
    <p>Short but user-selected main content should win.</p>
  </main>
  <article>
    <h1>Wrong Outside Article</h1>
    <p>This is a long external article outside the main element. It has enough text to tempt Readability if extraction accidentally ignores the selected scope. This second sentence adds more content. This third sentence adds even more content.</p>
  </article>
</body>
</html>`;

const bodyScopeHtml = `<!doctype html>
<html>
<head><title>Body Scope Test</title></head>
<body>
  <nav>
    <button aria-expanded="false" aria-controls="nav-panel">Jobs</button>
    <div id="nav-panel" hidden>Navigation panel should not count as main content.</div>
  </nav>
  <div>
    <h1>Body Fallback Content</h1>
    <p>There is no main or article element, so body fallback extraction should still ignore chrome signals.</p>
    <button aria-expanded="false" aria-controls="body-panel">Show more</button>
    <div id="body-panel" hidden>Body controlled panel content.</div>
  </div>
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
	if (req.url === "/article") {
		res.end(articleHtml);
		return;
	}
	if (req.url === "/scope") {
		res.end(scopedHtml);
		return;
	}
	if (req.url === "/body-scope") {
		res.end(bodyScopeHtml);
		return;
	}
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
	assert.equal(result.details.foldables.detected, 2);
	assert.equal(result.details.foldables.included, 1);
	assert.equal(result.details.foldables.ignored, 1);
	assert.equal(result.details.hidden.detected, 1);
	assert.equal(result.details.hidden.included, 0);
	assert.equal(result.details.quality.browserRecommended, false);

	const includeFoldables = await runWebFetch({ url: baseUrl, format: "markdown", scope: "main", foldables: "include" });
	assert.match(includeFoldables.output, /Hidden Secret/);
	assert.equal(includeFoldables.details.foldables.included, 2);
	assert.equal(includeFoldables.details.foldables.controlledPanelsIncluded, 1);
	assert.equal(includeFoldables.details.hidden.included, 1);

	const noFoldables = await runWebFetch({ url: baseUrl, format: "markdown", scope: "main", foldables: "ignore" });
	assert.doesNotMatch(noFoldables.output, /Folded Answer/);
	assert.equal(noFoldables.details.foldables.included, 0);

	const withHidden = await runWebFetch({ url: baseUrl, format: "markdown", scope: "main", hidden: "main" });
	assert.match(withHidden.output, /Hidden Secret/);
	assert.equal(withHidden.details.hidden.included, 1);

	const article = await runWebFetch({ url: new URL("article", baseUrl).toString(), format: "markdown", scope: "main" });
	assert.equal(article.details.extraction, "html-readability");
	assert.match(article.output, /## Readable Article/);
	assert.doesNotMatch(article.output, /Article navigation junk/);

	const scoped = await runWebFetch({ url: new URL("scope", baseUrl).toString(), format: "markdown", scope: "main" });
	assert.match(scoped.output, /# Main Content/);
	assert.doesNotMatch(scoped.output, /Wrong Outside Article/);

	const bodyScope = await runWebFetch({ url: new URL("body-scope", baseUrl).toString(), format: "markdown", scope: "main" });
	assert.equal(bodyScope.details.foldables.detected, 1);
	assert.equal(bodyScope.details.hidden.detected, 1);
	assert.doesNotMatch(bodyScope.output, /Navigation panel/);
	assert.doesNotMatch(bodyScope.output, /Body controlled panel/);

	const bodyScopeIncluded = await runWebFetch({
		url: new URL("body-scope", baseUrl).toString(),
		format: "markdown",
		scope: "main",
		foldables: "include",
	});
	assert.match(bodyScopeIncluded.output, /Body controlled panel content/);
	assert.doesNotMatch(bodyScopeIncluded.output, /Navigation panel/);
	assert.equal(bodyScopeIncluded.details.foldables.controlledPanelsIncluded, 1);

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
