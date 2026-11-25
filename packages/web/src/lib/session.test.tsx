import { InternalServerError, Unauthorized } from "@sugabots/contracts/http";
import { userText } from "@sugabots/errors";
import { act, renderHook, waitFor } from "@testing-library/react";
import { Data, Effect } from "effect";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { sam } from "@/api.test-support.tsx";
import { client } from "@/client.test-support.ts";
import { useSessionFromApi } from "@/lib/session.ts";

vi.mock("@/api.ts", () => import("@/client.test-support.ts"));

class Unreachable extends Data.TaggedError("Unreachable") {}

const meAsSam = { member: sam, workspaces: [] };

beforeEach(() => {
	client.api.me.mockReturnValue(Effect.succeed(meAsSam));
});

it("keeps a current user during a retryable refresh failure", async () => {
	const { result } = renderHook(useSessionFromApi);
	await waitFor(() => expect(result.current.member).toEqual(sam));
	client.api.me.mockReturnValue(
		Effect.fail(new InternalServerError({ message: userText`Unavailable` })),
	);

	await act(async () => {
		await expect(result.current.refresh()).rejects.toMatchObject({ _tag: "InternalServerError" });
	});

	expect(result.current.member).toEqual(sam);
	expect(result.current.error).toMatchObject({ _tag: "InternalServerError" });
});

it("can retry an initial retryable session failure", async () => {
	client.api.me
		.mockReturnValueOnce(Effect.fail(new InternalServerError({ message: userText`Unavailable` })))
		.mockReturnValueOnce(Effect.succeed(meAsSam));
	const { result } = renderHook(useSessionFromApi);
	await waitFor(() => expect(result.current.error).toMatchObject({ _tag: "InternalServerError" }));

	await act(async () => {
		await result.current.refresh();
	});

	expect(result.current.member).toEqual(sam);
	expect(result.current.error).toBeUndefined();
});

it("clears authentication when the API rejects the session", async () => {
	client.api.me.mockReturnValue(Effect.fail(new Unauthorized({ message: userText`Expired` })));
	const { result } = renderHook(useSessionFromApi);

	await waitFor(() => expect(result.current.member).toBeNull());

	expect(result.current.error).toBeUndefined();
});

it("forgets the last answer on signing out", async () => {
	const { result } = renderHook(useSessionFromApi);
	await waitFor(() => expect(result.current.me).toEqual(meAsSam));
	client.api.me.mockReturnValue(Effect.fail(new Unauthorized({ message: userText`Signed out` })));

	await act(() => result.current.refresh());

	expect(result.current.member).toBeNull();
	expect(result.current.me).toBeUndefined();
});

it("rides out the API restarting, without showing a dead end first", async () => {
	vi.useFakeTimers();
	onTestFinished(() => {
		vi.useRealTimers();
	});
	client.api.me
		.mockReturnValueOnce(Effect.fail(new Unreachable()))
		.mockReturnValueOnce(Effect.fail(new Unreachable()))
		.mockReturnValue(Effect.succeed(meAsSam));

	const { result } = renderHook(useSessionFromApi);

	await act(() => vi.advanceTimersToNextTimerAsync());
	expect(result.current.member).toBeUndefined();
	expect(result.current.error).toBeUndefined();

	await act(() => vi.runAllTimersAsync());
	expect(result.current.member).toEqual(sam);
	expect(result.current.error).toBeUndefined();
});

it("says so once the API has stopped answering for good", async () => {
	vi.useFakeTimers();
	onTestFinished(() => {
		vi.useRealTimers();
	});
	client.api.me.mockReturnValue(Effect.fail(new Unreachable()));

	const { result } = renderHook(useSessionFromApi);

	await act(() => vi.runAllTimersAsync());
	expect(result.current.error).toBeInstanceOf(Unreachable);
	expect(result.current.member).toBeUndefined();
});
