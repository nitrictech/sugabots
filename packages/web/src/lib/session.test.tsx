import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSession } from "@/lib/session.ts";
import { sam } from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

beforeEach(() => {
	client.api.me.$get.mockResolvedValue(Response.json(sam));
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

it("keeps an authenticated user during a transient refresh failure", async () => {
	const { result } = renderHook(useSession);
	await waitFor(() => expect(result.current.user).toEqual(sam));
	client.api.me.$get.mockResolvedValue(
		Response.json({ error: { code: "internal", message: "Unavailable" } }, { status: 500 }),
	);

	await act(async () => {
		await expect(result.current.refresh()).rejects.toMatchObject({ code: "internal" });
	});

	expect(result.current.user).toEqual(sam);
	expect(result.current.error).toMatchObject({ code: "internal" });
});

it("can retry an initial transient session failure", async () => {
	client.api.me.$get
		.mockResolvedValueOnce(
			Response.json({ error: { code: "internal", message: "Unavailable" } }, { status: 500 }),
		)
		.mockResolvedValueOnce(Response.json(sam));
	const { result } = renderHook(useSession);
	await waitFor(() => expect(result.current.error).toMatchObject({ code: "internal" }));

	await act(async () => {
		await result.current.refresh();
	});

	expect(result.current.user).toEqual(sam);
	expect(result.current.error).toBeUndefined();
});

it("discovers a cookie session without checking for a local token", async () => {
	client.tokens.get.mockReturnValue(undefined);
	const { result } = renderHook(useSession);

	await waitFor(() => expect(result.current.user).toEqual(sam));

	expect(client.tokens.get).not.toHaveBeenCalled();
});

it("clears authentication when the API rejects the session", async () => {
	client.api.me.$get.mockResolvedValue(
		Response.json({ error: { code: "unauthorized", message: "Expired" } }, { status: 401 }),
	);
	const { result } = renderHook(useSession);

	await waitFor(() => expect(result.current.user).toBeNull());

	expect(result.current.error).toBeUndefined();
});

it("rides out the API restarting, without showing a dead end first", async () => {
	// What a save in development looks like from the browser: the request never
	// reaches the API, twice, and then it is back.
	client.api.me.$get
		.mockRejectedValueOnce(new TypeError("Failed to fetch"))
		.mockRejectedValueOnce(new TypeError("Failed to fetch"))
		.mockResolvedValue(Response.json(sam));

	const { result } = renderHook(useSession);

	await waitFor(() => expect(result.current.user).toEqual(sam), { timeout: 3_000 });
	expect(result.current.error).toBeUndefined();
	expect(client.api.me.$get).toHaveBeenCalledTimes(3);
});

it("says so once the API has stopped answering for good", async () => {
	client.api.me.$get.mockRejectedValue(new TypeError("Failed to fetch"));

	const { result } = renderHook(useSession);

	await waitFor(() => expect(result.current.error).toBeInstanceOf(TypeError), { timeout: 15_000 });
	expect(result.current.user).toBeUndefined();
}, 20_000);
