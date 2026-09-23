import { describe, expect, it } from "vitest";
import { readablePage } from "./readable.ts";

describe("readablePage", () => {
	it("keeps the article and drops the furniture around it", () => {
		const html = `<!doctype html><html><head><title>Release notes | Example</title></head><body>
			<nav><a href="/">Home</a><a href="/blog">Blog</a></nav>
			<article>
				<h1>Release 2.4</h1>
				<p>This release adds <a href="/docs/tools">built-in tools</a> and fixes three bugs.</p>
				<p>${"It also improves reliability across the board. ".repeat(8)}</p>
				<p>${"Upgrading is a matter of pulling the new image and running the migrations. ".repeat(6)}</p>
				<p>${"Thanks to everyone who reported problems and tested the release candidates. ".repeat(6)}</p>
				<ul><li>Faster starts</li><li>Fewer restarts</li></ul>
			</article>
			<footer>© Example</footer>
			<script>track()</script>
		</body></html>`;

		const page = readablePage(html, "https://example.com/blog/release-2-4");

		expect(page.title).toBe("Release notes | Example");
		expect(page.markdown).toContain("# Release 2.4");
		expect(page.markdown).toContain("[built-in tools](https://example.com/docs/tools)");
		expect(page.markdown).toContain("- Faster starts");
		expect(page.markdown).not.toContain("Home");
		expect(page.markdown).not.toContain("track()");
	});

	it("keeps a listing page whole, less the site's furniture, rather than reading it as an article", () => {
		const html = `<html><head><title>nitrictech</title></head><body>
			<header><nav><a href="/">Home</a><a href="/explore">Explore</a></nav></header>
			<main>
				<h2>Repositories</h2>
				<ul>
					<li><h3><a href="/nitrictech/nitric">nitric</a></h3><p>A multi-language framework for cloud applications.</p><a href="/nitrictech/nitric/graphs/commit-activity"><svg></svg></a><span>Go</span></li>
					<li><h3><a href="/nitrictech/skills">skills</a></h3><p>Skills to help AI produce higher quality code.</p></li>
					<li><h3><a href="/nitrictech/sugapack">sugapack</a></h3><p>A remote buildkit frontend that wraps railpack.</p><span>Go</span></li>
				</ul>
			</main>
			<aside>People: 6</aside>
			<footer>© GitHub</footer>
		</body></html>`;

		const page = readablePage(html, "https://github.com/nitrictech");

		expect(page.title).toBe("nitrictech");
		expect(page.markdown).toContain("### [nitric](https://github.com/nitrictech/nitric)");
		expect(page.markdown).toContain("### [sugapack](https://github.com/nitrictech/sugapack)");
		expect(page.markdown).toContain("A multi-language framework for cloud applications.");
		expect(page.markdown).not.toContain("[](");
		expect(page.markdown).not.toContain("Explore");
		expect(page.markdown).not.toContain("People: 6");
		expect(page.markdown).not.toContain("© GitHub");
	});

	it("falls back to the whole body when there is no article to find", () => {
		const page = readablePage(
			"<html><head><title>Ping</title></head><body><p>pong</p></body></html>",
			"https://example.com/ping",
		);

		expect(page.title).toBe("Ping");
		expect(page.markdown).toBe("pong");
	});
});
