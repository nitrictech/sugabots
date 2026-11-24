import { MAX_ARTIFACT_IMAGE_BYTES, MAX_ARTIFACT_IMAGES_BYTES } from "@sugabots/contracts";
import { type ArtifactImageIds, artifactImageIds } from "@sugabots/contracts/http";
import { Artifacts } from "@sugabots/core/artifacts/artifacts";
import { ResourceHidden } from "@sugabots/core/authorization/access";
import { unimplemented } from "@sugabots/core/testing";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	BASE_URL,
	createTestApp,
	identifiedBy,
	type UserResolver,
} from "../../http/app.test-support.ts";

/**
 * The routes that keep a document's images and serve them back, over doubles
 * of `Artifacts`. Who may reach a document's images is decided in core.
 */

const POD = "0199a3a0-0000-7000-8000-000000000001";
const ARTIFACT = "0199a3a0-0000-7000-8000-000000000002";
const IMAGES = `/pods/${POD}/artifacts/${ARTIFACT}/images`;

const resolveUser: UserResolver = async (headers) =>
	headers.get("authorization") === "Bearer member"
		? {
				id: "0199a3a0-0000-7000-8000-0000000000ff",
				name: "Sam",
				email: "sam@example.com",
				image: null,
			}
		: null;

const app = (artifacts: Partial<Artifacts.Interface>) =>
	createTestApp(
		Layer.merge(identifiedBy(resolveUser), unimplemented(Artifacts.Service, artifacts)),
	);

const signedIn = { authorization: "Bearer member" };

const PNG = new Uint8Array([137, 80, 78, 71]);

const KEPT = artifactImageIds({ podId: POD, artifactId: ARTIFACT, imageId: "d".repeat(64) });

/** A document keeping one image, `PNG`, which it answers every upload with. */
const keepingOne = () => {
	if (!KEPT) throw new Error("fixture");
	const kept: ArtifactImageIds = KEPT;
	return app({
		uploadImage: ({ stream }) => Stream.runDrain(stream).pipe(Effect.orDie, Effect.as(kept)),
		image: (image) =>
			image.imageId === kept.imageId
				? Effect.succeed({
						contentType: "image/png",
						size: PNG.byteLength,
						stream: Stream.succeed(PNG),
					})
				: Effect.fail(new Artifacts.ImageNotFound({ imageId: image.imageId })),
	});
};

describe("keeping an image for a document", () => {
	it("keeps the body as the type it names, answering the address the document shows it from", async () => {
		let kept: unknown;
		const response = await app({
			uploadImage: ({ podId, artifactId, contentType, stream }) =>
				Effect.gen(function* () {
					const chunks = yield* Stream.runCollect(stream).pipe(Effect.orDie);
					kept = { podId, artifactId, contentType, bytes: new Uint8Array(Buffer.concat(chunks)) };
					if (!KEPT) return yield* Effect.die("fixture");
					return KEPT;
				}),
		}).request(`${IMAGES}?type=image%2Fpng`, { method: "POST", headers: signedIn, body: PNG });

		expect(response.status).toBe(201);
		expect(kept).toEqual({
			podId: POD,
			artifactId: ARTIFACT,
			contentType: "image/png",
			bytes: PNG,
		});
		expect(await response.json()).toEqual({ address: `/api${IMAGES}/${"d".repeat(64)}` });
	});

	it("refuses an SVG, which can carry script", async () => {
		const response = await app({}).request(`${IMAGES}?type=image%2Fsvg%2Bxml`, {
			method: "POST",
			headers: signedIn,
			body: "<svg/>",
		});

		expect(response.status).toBe(400);
	});

	it("refuses an image that says it is over the limit before reading it", async () => {
		const response = await app({}).request(`${IMAGES}?type=image%2Fpng`, {
			method: "POST",
			headers: { ...signedIn, "content-length": String(MAX_ARTIFACT_IMAGE_BYTES + 1) },
			body: new Uint8Array(1),
		});

		expect(response.status).toBe(413);
	});

	it("refuses an image over the limit that doesn't say how large it is", async () => {
		const megabyte = new Uint8Array(1024 * 1024);
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent > MAX_ARTIFACT_IMAGE_BYTES) return controller.close();
				sent += megabyte.byteLength;
				controller.enqueue(megabyte);
			},
		});
		const init: RequestInit & { duplex: "half" } = {
			method: "POST",
			headers: signedIn,
			body,
			duplex: "half",
		};

		const response = await app({
			uploadImage: ({ stream }) =>
				Effect.gen(function* () {
					yield* Stream.runDrain(stream);
					if (!KEPT) return yield* Effect.die("fixture");
					return KEPT;
				}),
		}).request(`${IMAGES}?type=image%2Fpng`, init);

		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({
			message: "The image is larger than 10 MB, the most a document keeps of one",
		});
	});

	it("refuses an image whose bytes aren't of the type it names", async () => {
		const response = await app({
			uploadImage: ({ contentType }) => Effect.fail(new Artifacts.ImageNotOfType({ contentType })),
		}).request(`${IMAGES}?type=image%2Fpng`, {
			method: "POST",
			headers: signedIn,
			body: new TextEncoder().encode("GIF89a"),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			_tag: "BadRequest",
			message: "The file says it is a PNG image, but its content isn't one",
		});
	});

	it("says so when the document's images would come to more than it keeps", async () => {
		const response = await app({
			uploadImage: () =>
				Effect.fail(new Artifacts.ImagesFull({ maxSize: MAX_ARTIFACT_IMAGES_BYTES })),
		}).request(`${IMAGES}?type=image%2Fpng`, { method: "POST", headers: signedIn, body: PNG });

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			_tag: "Conflict",
			message: "A document keeps 50 MB of images at most, and this one would take it past that",
		});
	});

	it("answers not found where core hides the document from the person", async () => {
		const response = await app({
			uploadImage: () => Effect.fail(new ResourceHidden({ resource: "artifact" })),
		}).request(`${IMAGES}?type=image%2Fpng`, { method: "POST", headers: signedIn, body: PNG });

		expect(response.status).toBe(404);
	});

	it("keeps nothing for somebody who isn't signed in", async () => {
		const response = await app({}).request(`${IMAGES}?type=image%2Fpng`, {
			method: "POST",
			body: PNG,
		});

		expect(response.status).toBe(401);
	});
});

describe("serving a document's image", () => {
	it("serves the image at the address its upload answered, as the type it was kept as", async () => {
		const serving = keepingOne();
		const uploaded = await serving.request(`${IMAGES}?type=image%2Fpng`, {
			method: "POST",
			headers: signedIn,
			body: PNG,
		});
		const { address } = (await uploaded.json()) as { address: string };

		const response = await serving.fetch(
			new Request(new URL(address, BASE_URL), { headers: signedIn }),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("content-disposition")).toBe("inline");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("content-security-policy")).toBe("sandbox");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
	});

	it("answers not found for an image the document doesn't keep, or an id no image has", async () => {
		const serving = keepingOne();

		for (const imageId of ["e".repeat(64), "0199a3a0-0000-7000-8000-000000000099"]) {
			const response = await serving.request(`${IMAGES}/${imageId}`, { headers: signedIn });
			expect(response.status).toBe(404);
		}
	});

	it("shows nothing to somebody who isn't signed in", async () => {
		const response = await keepingOne().request(`${IMAGES}/${"d".repeat(64)}`);

		expect(response.status).toBe(401);
	});
});
