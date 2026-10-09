import { InternalServerError, Unauthorized } from "@sugabots/contracts/http";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Data, Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSessionFromApi } from "@/lib/session.ts";
import { sam } from "@/test-api.tsx";
import { client } from "@/test-client.ts";

vi.mock("@/api.ts", () => import("@/test-client.ts"));

class Unreachable extends Data.TaggedError("Unreachable") {}

const meAsSam = { user: sam, workspaces: [] };

beforeEach(() => {
	client.api.me.mockReturnValue(Effect.succeed(meAsSam));
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

it("keeps an authenticated user during a transient refresh failure", async () => {
	const { result } = renderHook(useSessionFromApi);
	await waitFor(() => expect(result.current.user).toEqual(sam));
	client.api.me.mockReturnValue(Effect.fail(new InternalServerError({ message: "Unavailable" })));

	await act(async () => {
		await expect(result.current.refresh()).rejects.toMatchObject({ _tag: "InternalServerError" });
	});

	expect(result.current.user).toEqual(sam);
	expect(result.current.error).toMatchObject({ _tag: "InternalServerError" });
});

it("can retry an initial transient session failure", async () => {
	client.api.me
		.mockReturnValueOnce(Effect.fail(new InternalServerError({ message: "Unavailable" })))
		.mockReturnValueOnce(Effect.succeed(meAsSam));
	const { result } = renderHook(useSessionFromApi);
	await waitFor(() => expect(result.current.error).toMatchObject({ _tag: "InternalServerError" }));

	await act(async () => {
		await result.current.refresh();
	});

	expect(result.current.user).toEqual(sam);
	expect(result.current.error).toBeUndefined();
});

it("discovers a cookie session without checking for a local token", async () => {
	client.tokens.get.mockReturnValue(undefined);
	const { result } = renderHook(useSessionFromApi);

	await waitFor(() => expect(result.current.user).toEqual(sam));

	expect(client.tokens.get).not.toHaveBeenCalled();
});

it("clears authentication when the API rejects the session", async () => {
	client.api.me.mockReturnValue(Effect.fail(new Unauthorized({ message: "Expired" })));
	const { result } = renderHook(useSessionFromApi);

	await waitFor(() => expect(result.current.user).toBeNull());

	expect(result.current.error).toBeUndefined();
});

it("forgets the last answer on signing out", async () => {
	const { result } = renderHook(useSessionFromApi);
	await waitFor(() => expect(result.current.me).toEqual(meAsSam));
	client.api.me.mockReturnValue(Effect.fail(new Unauthorized({ message: "Signed out" })));

	await act(() => result.current.refresh());

	expect(result.current.user).toBeNull();
	expect(result.current.me).toBeUndefined();
});

it("rides out the API restarting, without showing a dead end first", async () => {
	// What a save in development looks like from the browser: the request never
	// reaches the API, twice, and then it is back.
	client.api.me
		.mockReturnValueOnce(Effect.fail(new Unreachable()))
		.mockReturnValueOnce(Effect.fail(new Unreachable()))
		.mockReturnValue(Effect.succeed(meAsSam));

	const { result } = renderHook(useSessionFromApi);

	await waitFor(() => expect(result.current.user).toEqual(sam), { timeout: 3_000 });
	expect(result.current.error).toBeUndefined();
	expect(client.api.me).toHaveBeenCalledTimes(3);
});

it("says so once the API has stopped answering for good", async () => {
	client.api.me.mockReturnValue(Effect.fail(new Unreachable()));

	const { result } = renderHook(useSessionFromApi);

	await waitFor(() => expect(result.current.error).toBeInstanceOf(Unreachable), {
		timeout: 15_000,
	});
	expect(result.current.user).toBeUndefined();
}, 20_000);
