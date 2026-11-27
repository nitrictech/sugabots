import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
});

/** `apiBaseUrl` as the page reads it with `VITE_API_URL` set to `configured`. */
async function apiBaseUrlWith(configured: string) {
	vi.stubEnv("VITE_API_URL", configured);
	vi.resetModules();
	return (await import("./api-url.ts")).apiBaseUrl;
}

describe("apiBaseUrl", () => {
	it("reads a path against the page's origin", async () => {
		expect(await apiBaseUrlWith("/api/")).toBe(`${window.location.origin}/api`);
	});

	it("keeps a whole address", async () => {
		expect(await apiBaseUrlWith("https://api.example.com/v1")).toBe("https://api.example.com/v1");
	});
});
