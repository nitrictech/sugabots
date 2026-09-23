import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultTokenStore, localStorageTokenStore } from "./tokens.ts";

afterEach(() => vi.unstubAllGlobals());

describe("localStorageTokenStore", () => {
	it("keeps tokens in memory when storage writes fail", () => {
		vi.stubGlobal("localStorage", {
			getItem: vi.fn(() => null),
			setItem: vi.fn(() => {
				throw new Error("Storage disabled");
			}),
			removeItem: vi.fn(() => {
				throw new Error("Storage disabled");
			}),
		});
		const tokens = localStorageTokenStore();

		tokens.set("issued");

		expect(tokens.get()).toBe("issued");
		expect(() => tokens.set(undefined)).not.toThrow();
		expect(tokens.get()).toBeUndefined();
	});

	it("switches to memory when storage reads fail", () => {
		vi.stubGlobal("localStorage", {
			getItem: vi.fn(() => {
				throw new Error("Storage disabled");
			}),
			setItem: vi.fn(),
			removeItem: vi.fn(),
		});
		const tokens = localStorageTokenStore("token");

		expect(tokens.get()).toBeUndefined();
		expect(() => tokens.set("session-only")).not.toThrow();
		expect(tokens.get()).toBe("session-only");
	});
});

it("keeps the default browser token store in memory", () => {
	vi.stubGlobal("window", {});
	const tokens = defaultTokenStore();
	tokens.set("renderer-token");

	expect(tokens.get()).toBe("renderer-token");
});
