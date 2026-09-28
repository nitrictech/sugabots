import { describe, expect, it } from "vitest";
import worker, { type Env } from "./worker.ts";

const SITE = "https://sugabots.test";

const files: Record<string, { body: string; type: string }> = {
	"/": { body: "<h1>Sugabots</h1>", type: "text/html" },
	"/index.md": { body: "# Sugabots", type: "text/markdown" },
	"/docs/quickstart": { body: "<h1>Quickstart</h1>", type: "text/html" },
	"/docs/quickstart.md": { body: "# Quickstart", type: "text/markdown" },
	"/changelog": { body: "<h1>Changelog</h1>", type: "text/html" },
	"/og.png": { body: "PNG", type: "image/png" },
};

const env: Env = {
	ASSETS: {
		async fetch(request) {
			const file = files[new URL(request.url).pathname];
			if (!file) return new Response(null, { status: 404 });
			return new Response(file.body, { headers: { "Content-Type": file.type } });
		},
	},
};

const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

async function get(path: string, accept?: string) {
	const headers = new Headers();
	if (accept !== undefined) headers.set("Accept", accept);
	const response = await worker.fetch(new Request(`${SITE}${path}`, { headers }), env);
	return { response, body: await response.text() };
}

function varyTokens(response: Response) {
	return new Set(
		(response.headers.get("Vary") ?? "")
			.split(",")
			.map((token) => token.trim().toLowerCase())
			.filter(Boolean),
	);
}

describe("a page", () => {
	it("is Markdown for a request that asks for Markdown", async () => {
		const { response, body } = await get("/docs/quickstart", "text/markdown");
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
		expect(varyTokens(response)).toEqual(new Set(["accept"]));
		expect(body).toBe("# Quickstart");
	});

	it("is the homepage's Markdown version at the root", async () => {
		const { body } = await get("/", "text/markdown");
		expect(body).toBe("# Sugabots");
	});

	it("is HTML for a browser, marked as varying by Accept", async () => {
		const { response, body } = await get("/docs/quickstart", BROWSER_ACCEPT);
		expect(response.headers.get("Content-Type")).toBe("text/html");
		expect(varyTokens(response)).toEqual(new Set(["accept"]));
		expect(body).toBe("<h1>Quickstart</h1>");
	});

	it.each([
		["no Accept header", undefined],
		["anything accepted", "*/*"],
		["Markdown rated below HTML", "text/markdown;q=0.5, text/html"],
		["Markdown rated below a wildcard", "text/markdown;q=0.5, */*"],
		["Markdown refused", "text/markdown;q=0, text/html"],
	])("is HTML with %s", async (_, accept) => {
		const { body } = await get("/docs/quickstart", accept);
		expect(body).toBe("<h1>Quickstart</h1>");
	});

	it("is Markdown when it's rated above HTML", async () => {
		const { body } = await get("/docs/quickstart", "text/html;q=0.9, text/markdown");
		expect(body).toBe("# Quickstart");
	});

	it.each(["2", "Infinity", "-1", "1e0", "0.9999", "1.001"])(
		"treats invalid Markdown quality %s as zero",
		async (quality) => {
			const { body } = await get("/docs/quickstart", `text/markdown;q=${quality}, text/html;q=0.5`);
			expect(body).toBe("<h1>Quickstart</h1>");
		},
	);

	it.each(["0.999", "1", "1.", "1.000"])("accepts Markdown quality %s", async (quality) => {
		const { body } = await get("/docs/quickstart", `text/markdown;q=${quality}, text/html;q=0.5`);
		expect(body).toBe("# Quickstart");
	});

	it("is HTML when it has no Markdown version", async () => {
		const { response, body } = await get("/changelog", "text/markdown");
		expect(response.status).toBe(200);
		expect(body).toBe("<h1>Changelog</h1>");
	});
});

describe("a missing page", () => {
	it("is a Markdown 404 that points to llms.txt, for a request that asks for Markdown", async () => {
		const { response, body } = await get("/nowhere", "text/markdown");
		expect(response.status).toBe(404);
		expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
		expect(varyTokens(response)).toEqual(new Set(["accept"]));
		expect(body).toContain("/llms.txt");
	});

	it("preserves the asset's 404 response for a browser", async () => {
		const assets: Env["ASSETS"] = {
			async fetch() {
				return new Response("<h1>Not found</h1>", {
					status: 404,
					headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" },
				});
			},
		};
		const request = new Request(`${SITE}/nowhere`, { headers: { Accept: BROWSER_ACCEPT } });
		const response = await worker.fetch(request, { ASSETS: assets });

		expect(response.status).toBe(404);
		expect(response.headers.get("Content-Type")).toBe("text/html");
		expect(response.headers.get("Cache-Control")).toBe("no-cache");
		expect(varyTokens(response)).toEqual(new Set(["accept"]));
		expect(await response.text()).toBe("<h1>Not found</h1>");
	});
});

describe("Markdown asset responses", () => {
	it.each([
		{
			name: "a complete response",
			status: 200,
			body: "# Quickstart",
			requestHeaders: new Headers(),
			assetHeaders: new Headers(),
		},
		{
			name: "a byte range",
			status: 206,
			body: "# Qui",
			requestHeaders: new Headers({ Range: "bytes=0-4" }),
			assetHeaders: new Headers({ "Content-Range": "bytes 0-4/12", "Content-Length": "5" }),
		},
		{
			name: "an unchanged representation",
			status: 304,
			body: null,
			requestHeaders: new Headers({ "If-None-Match": '"quickstart-markdown"' }),
			assetHeaders: new Headers(),
		},
	])("preserves the status and metadata of $name", async (asset) => {
		const assets: Env["ASSETS"] = {
			async fetch(request) {
				if (new URL(request.url).pathname !== "/docs/quickstart.md") {
					return env.ASSETS.fetch(request);
				}
				for (const [name, value] of asset.requestHeaders) {
					expect(request.headers.get(name)).toBe(value);
				}
				const headers = new Headers(asset.assetHeaders);
				headers.set("Content-Type", "text/plain");
				headers.set("ETag", '"quickstart-markdown"');
				headers.set("Cache-Control", "public, max-age=0, must-revalidate");
				headers.set("Vary", "Accept-Encoding");
				return new Response(asset.body, { status: asset.status, headers });
			},
		};
		const headers = new Headers(asset.requestHeaders);
		headers.set("Accept", "text/markdown");
		const request = new Request(`${SITE}/docs/quickstart`, { headers });
		const response = await worker.fetch(request, { ASSETS: assets });

		expect(response.status).toBe(asset.status);
		expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
		expect(response.headers.get("ETag")).toBe('"quickstart-markdown"');
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
		expect(varyTokens(response)).toEqual(new Set(["accept-encoding", "accept"]));
		for (const [name, value] of asset.assetHeaders) {
			expect(response.headers.get(name)).toBe(value);
		}
		expect(await response.text()).toBe(asset.body ?? "");
	});

	it.each([416, 503])("preserves asset errors with status %i", async (status) => {
		const assets: Env["ASSETS"] = {
			async fetch(request) {
				if (new URL(request.url).pathname !== "/docs/quickstart.md") {
					return env.ASSETS.fetch(request);
				}
				return new Response("Asset request failed", {
					status,
					headers: { "Content-Type": "text/plain" },
				});
			},
		};
		const request = new Request(`${SITE}/docs/quickstart`, {
			headers: { Accept: "text/markdown" },
		});
		const response = await worker.fetch(request, { ASSETS: assets });

		expect(response.status).toBe(status);
		expect(response.headers.get("Content-Type")).toBe("text/plain");
		expect(varyTokens(response)).toEqual(new Set(["accept"]));
		expect(await response.text()).toBe("Asset request failed");
	});
});

describe("a file", () => {
	it("is served as it is, even to a request that asks for Markdown", async () => {
		const { response, body } = await get("/og.png", "text/markdown");
		expect(response.headers.get("Content-Type")).toBe("image/png");
		expect(response.headers.get("Vary")).toBeNull();
		expect(body).toBe("PNG");
	});
});
