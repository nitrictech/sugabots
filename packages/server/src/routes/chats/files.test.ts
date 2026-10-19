import { MAX_ATTACHMENT_BYTES } from "@sugabots/contracts";
import { ChatFiles } from "@sugabots/core/conversations/chats/chat-files";
import { ThreadFiles } from "@sugabots/core/conversations/thread-files/thread-files";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { createTestApp, identifiedBy, type UserResolver } from "../../http/app.test-support.ts";

/**
 * The routes that upload a chat's files and serve them back, over doubles of
 * `ChatFiles`. Who may reach a chat's files is decided in core.
 */

const CHAT = "0199a3a0-0000-7000-8000-000000000401";
const FILE = "0199a3a0-0000-7000-8000-000000000501";

const resolveUser: UserResolver = async () => ({
	id: "0199a3a0-0000-7000-8000-000000000002",
	name: "Sam",
	email: "sam@example.com",
	image: null,
});

const app = (files: Partial<ChatFiles.Interface>) =>
	createTestApp(Layer.merge(identifiedBy(resolveUser), unimplemented(ChatFiles.Service, files)));

const signedIn = { authorization: "Bearer member" };

/** A `read` that finds one file, with `bytes` as its content. */
const serving = (file: { name: string; contentType: string; bytes: Uint8Array }) =>
	app({
		read: ({ fileId }) =>
			fileId === FILE
				? Effect.succeed({
						id: FILE,
						name: file.name,
						contentType: file.contentType,
						size: file.bytes.byteLength,
						stream: Stream.succeed(file.bytes),
					})
				: Effect.fail(new ThreadFiles.FileNotFound({ fileId })),
	});

describe("uploading a chat file", () => {
	it("keeps the body as the named file, with the type it names", async () => {
		let kept: unknown;
		const name = encodeURIComponent("notes été.txt");
		const type = encodeURIComponent("text/plain; charset=utf-8");
		const response = await app({
			upload: ({ chatId, name, type, stream }) =>
				Effect.gen(function* () {
					const chunks = yield* Stream.runCollect(stream).pipe(Effect.orDie);
					kept = { chatId, name, type, text: Buffer.concat(chunks).toString() };
					return { id: FILE, name, contentType: type ?? "", size: 5 };
				}),
		}).request(`/chats/${CHAT}/files?name=${name}&type=${type}`, {
			method: "POST",
			headers: signedIn,
			body: "hello",
		});

		expect(response.status).toBe(201);
		expect(kept).toEqual({
			chatId: CHAT,
			name: "notes été.txt",
			type: "text/plain; charset=utf-8",
			text: "hello",
		});
		expect(await response.json()).toEqual({
			id: FILE,
			name: "notes été.txt",
			contentType: "text/plain; charset=utf-8",
			size: 5,
		});
	});

	it("leaves the type to the name when the uploader names none", async () => {
		let type: string | undefined = "not called";
		const response = await app({
			upload: (input) => {
				type = input.type;
				return Effect.succeed({
					id: FILE,
					name: input.name,
					contentType: "text/markdown",
					size: 0,
				});
			},
		}).request(`/chats/${CHAT}/files?name=notes.md`, {
			method: "POST",
			headers: signedIn,
			body: "# notes",
		});

		expect(response.status).toBe(201);
		expect(type).toBeUndefined();
	});

	it("refuses a type that could break out of the file's header", async () => {
		const type = encodeURIComponent("text/plain\r\nset-cookie: a=b");
		const response = await app({}).request(`/chats/${CHAT}/files?name=a.txt&type=${type}`, {
			method: "POST",
			headers: signedIn,
			body: "a",
		});

		expect(response.status).toBe(400);
	});

	it("refuses a file that says it is over the limit before reading it", async () => {
		const response = await app({}).request(`/chats/${CHAT}/files?name=huge.zip`, {
			method: "POST",
			headers: {
				...signedIn,
				"content-type": "application/zip",
				"content-length": String(MAX_ATTACHMENT_BYTES + 1),
			},
			body: new Uint8Array(1),
		});

		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({ _tag: "PayloadTooLarge" });
	});
});

describe("serving a chat file", () => {
	it("shows an image in place, as its own type and never sniffed for another", async () => {
		const response = await serving({
			name: "chart.png",
			contentType: "image/png",
			bytes: new Uint8Array([137, 80, 78, 71]),
		}).request(`/chats/${CHAT}/files/${FILE}`, { headers: signedIn });

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("content-disposition")).toBe(
			`inline; filename="chart.png"; filename*=UTF-8''chart.png`,
		);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("content-security-policy")).toBe("sandbox");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
	});

	it("offers a page as a download under its name, never as a page of the app", async () => {
		const response = await serving({
			name: "résumé.html",
			contentType: "text/html",
			bytes: new TextEncoder().encode("<script>alert(1)</script>"),
		}).request(`/chats/${CHAT}/files/${FILE}`, { headers: signedIn });

		expect(response.headers.get("content-disposition")).toBe(
			`attachment; filename="r_sum_.html"; filename*=UTF-8''r%C3%A9sum%C3%A9.html`,
		);
		expect(response.headers.get("content-security-policy")).toBe("sandbox");
	});

	it("answers not found for a file the chat does not have", async () => {
		const response = await serving({
			name: "chart.png",
			contentType: "image/png",
			bytes: new Uint8Array(),
		}).request(`/chats/${CHAT}/files/0199a3a0-0000-7000-8000-000000000599`, { headers: signedIn });

		expect(response.status).toBe(404);
	});
});
