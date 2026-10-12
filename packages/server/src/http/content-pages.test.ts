import { ArtifactPages } from "@sugabots/core/artifacts/pages";
import { Installation } from "@sugabots/core/installation/installation";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { BASE_URL, createTestApp, WEB_ORIGIN } from "./app.test-support.ts";

const CONTENT_ORIGIN = "https://pages.example-content.com";

/** As long as a sealed token: over the 100 characters the router allows a path parameter. */
const SEALED = `v1.${"x".repeat(220)}`;

/** The app with pages at `CONTENT_ORIGIN`, where the token `SEALED` opens a page and any other is unavailable. */
const withPages = (contentOrigin: string | undefined = CONTENT_ORIGIN) =>
	createTestApp(
		Layer.mergeAll(
			Layer.succeed(
				Installation.Service,
				Installation.fromUrls({
					isProduction: false,
					publicUrl: BASE_URL,
					webAppUrl: WEB_ORIGIN,
					...(contentOrigin ? { contentOrigin } : {}),
				}),
			),
			unimplemented(ArtifactPages.Service, {
				open: (token) =>
					token === SEALED
						? Effect.succeed({ title: "Chart", html: "<!doctype html><p>chart</p>" })
						: Effect.fail(new ArtifactPages.PageUnavailable()),
			}),
		),
	);

const get = (app: ReturnType<typeof createTestApp>, origin: string, path: string) =>
	app.fetch(new Request(new URL(path, origin), { headers: { host: new URL(origin).host } }));

describe("pages on the content origin", () => {
	it("serves a page there under its own sandboxing policy", async () => {
		const response = await get(withPages(), CONTENT_ORIGIN, `/pages/${SEALED}`);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-security-policy")).toMatch(
			/^sandbox allow-scripts; default-src 'none';.*frame-ancestors http:\/\/localhost:3000 http:\/\/localhost:5173$/,
		);
		expect(response.headers.get("allow-csp-from")).toBe(WEB_ORIGIN);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		const body = await response.text();
		expect(body).toMatch(/^<!doctype html><script>.*location\.hash.*<\/script><p>chart<\/p>/s);
	});

	it("answers an expired or forged address with not found", async () => {
		expect((await get(withPages(), CONTENT_ORIGIN, "/pages/forged")).status).toBe(404);
	});

	it("serves nothing else there, not the API nor the web app", async () => {
		const app = withPages();

		expect((await get(app, CONTENT_ORIGIN, "/api/health")).status).toBe(404);
		expect((await get(app, CONTENT_ORIGIN, "/")).status).toBe(404);
	});

	it.each([
		"PAGES.example-content.com",
		"pages.example-content.com.",
		"pages.example-content.com:443",
		"pages.example-content.com:0443",
	])("knows the content origin when its host is sent as %s", async (host) => {
		const app = withPages();
		const sentTo = (path: string) =>
			app.fetch(new Request(new URL(path, CONTENT_ORIGIN), { headers: { host } }));

		expect((await sentTo(`/pages/${SEALED}`)).status).toBe(200);
		expect((await sentTo("/api/health")).status).toBe(404);
	});

	it("knows a content origin configured with a trailing dot", async () => {
		const app = withPages("https://pages.example-content.com.");
		const sentTo = (path: string) =>
			app.fetch(
				new Request(new URL(path, CONTENT_ORIGIN), {
					headers: { host: "pages.example-content.com" },
				}),
			);

		expect((await sentTo(`/pages/${SEALED}`)).status).toBe(200);
		expect((await sentTo("/api/health")).status).toBe(404);
	});

	it("tells another port on the content origin's hostname apart from it", async () => {
		const app = withPages("https://pages.example-content.com:8443");
		const sentTo = (host: string) =>
			app.fetch(new Request(new URL(`/pages/${SEALED}`, CONTENT_ORIGIN), { headers: { host } }));

		expect((await sentTo("pages.example-content.com:8443")).status).toBe(200);
		expect((await sentTo("pages.example-content.com:80")).status).toBe(404);
	});

	it("serves no page from the app's own origin", async () => {
		expect((await get(withPages(), BASE_URL, `/pages/${SEALED}`)).status).toBe(404);
	});

	it("has no page route without a content origin", async () => {
		const response = await get(withPages(undefined), BASE_URL, `/pages/${SEALED}`);

		expect(response.status).toBe(404);
		expect(response.headers.get("content-security-policy")).toBeNull();
	});
});
