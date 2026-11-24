import { MAX_ARTIFACT_IMAGE_BYTES } from "@sugabots/contracts";
import {
	artifactImageAddress,
	artifactImageIds,
	BadRequest,
	Conflict,
	NotFound,
	PayloadTooLarge,
} from "@sugabots/contracts/http";
import { Artifacts } from "@sugabots/core/artifacts/artifacts";
import { ArtifactPages } from "@sugabots/core/artifacts/pages";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { asSessionUser } from "../../auth/middleware.ts";
import { ServerApi } from "../../http/api.ts";
import { asHttpError, refusals, storeOutagesAsDefects } from "../../http/errors.ts";
import { fileResponse } from "../../http/file-response.ts";
import { uploadedBody } from "../../http/uploads.ts";

export const artifactRoutes = HttpApiBuilder.group(ServerApi, "artifacts", (handlers) =>
	Effect.gen(function* () {
		const artifacts = yield* Artifacts.Service;
		const pages = yield* ArtifactPages.Service;
		return handlers
			.handle("list", ({ params }) =>
				artifacts.list(params).pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("get", ({ params }) =>
				artifacts.get(params).pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("versions", ({ params }) =>
				artifacts.versions(params).pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("getVersion", ({ params }) =>
				artifacts.getVersion(params).pipe(asSessionUser, asHttpError(refusals)),
			)
			.handle("pageAddress", ({ params }) =>
				pages.address(params).pipe(
					Effect.map((url) => ({ url: url ?? null })),
					asSessionUser,
					asHttpError(refusals),
				),
			)
			.handle("remove", ({ params }) =>
				artifacts.remove(params).pipe(asSessionUser, asHttpError(refusals)),
			)
			.handleRaw("uploadImage", ({ params, query, request }) =>
				// Raw, so the image streams to the service rather than being decoded first.
				Effect.gen(function* () {
					const stream = yield* uploadedBody(
						request,
						MAX_ARTIFACT_IMAGE_BYTES,
						() => new Artifacts.ImageTooLarge({ maxSize: MAX_ARTIFACT_IMAGE_BYTES }),
					);
					const image = yield* artifacts.uploadImage({
						...params,
						contentType: query.type,
						stream,
					});
					return { address: artifactImageAddress(image) };
				}).pipe(Effect.catchTags(storeOutagesAsDefects), asSessionUser, asHttpError(imageErrors)),
			)
			.handle("image", ({ params }) =>
				Effect.gen(function* () {
					// An id of no form an image's address holds names no image.
					const image = artifactImageIds(params);
					if (!image) return yield* new Artifacts.ImageNotFound({ imageId: params.imageId });
					return fileResponse(yield* artifacts.image(image));
				}).pipe(Effect.catchTags(storeOutagesAsDefects), asSessionUser, asHttpError(imageErrors)),
			);
	}),
);

const imageErrors = {
	...refusals,
	ArtifactImageTooLarge: PayloadTooLarge,
	ArtifactImageNotOfType: BadRequest,
	ArtifactImagesFull: Conflict,
	ArtifactImageNotFound: NotFound,
};
