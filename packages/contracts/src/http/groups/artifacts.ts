import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import {
	ARTIFACT_IMAGE_PATH,
	artifactImageTypeSchema,
	artifactSchema,
	artifactSummarySchema,
	artifactVersionSummarySchema,
} from "../../artifacts.ts";
import { uuidSchema } from "../../uuid.ts";
import { BadRequest, Conflict, PayloadTooLarge, refused } from "../errors.ts";
import { Session } from "../middleware.ts";

const root = "/pods/:podId/artifacts";
const pod = { podId: uuidSchema };
const artifact = { podId: uuidSchema, artifactId: uuidSchema };
// The image's id is checked with the others where the route reads them (`artifactImageIds`).
const image = { ...artifact, imageId: Schema.String };
const version = {
	...artifact,
	version: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0)),
};

export class ArtifactsApi extends HttpApiGroup.make("artifacts")
	.add(
		HttpApiEndpoint.get("list", root, {
			params: pod,
			success: Schema.Array(artifactSummarySchema),
			error: refused,
		}),
		HttpApiEndpoint.get("get", `${root}/:artifactId`, {
			params: artifact,
			success: artifactSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("versions", `${root}/:artifactId/versions`, {
			params: artifact,
			success: Schema.Array(artifactVersionSummarySchema),
			error: refused,
		}),
		HttpApiEndpoint.get("getVersion", `${root}/:artifactId/versions/:version`, {
			params: version,
			success: artifactSchema,
			error: refused,
		}),
		HttpApiEndpoint.get("pageAddress", `${root}/:artifactId/versions/:version/page`, {
			params: version,
			success: Schema.Struct({
				/** Where the page loads from on the content origin, for a few minutes; `null` when no content origin is set. */
				url: Schema.NullOr(Schema.String),
			}),
			error: refused,
		}),
		HttpApiEndpoint.delete("remove", `${root}/:artifactId`, {
			params: artifact,
			error: refused,
		}),
		/**
		 * Keeps an image for a `document` artifact to show, for anyone who can
		 * read the document. The body is the image's bytes, and `type` its media
		 * type. Answers the address the document refers to it by, which
		 * `artifactImageAddress` makes; the same image kept again answers the
		 * same address. `BadRequest` when the bytes aren't an image of `type`,
		 * and `Conflict` when the document's images would come to more than
		 * `MAX_ARTIFACT_IMAGES_BYTES`.
		 */
		HttpApiEndpoint.post("uploadImage", `${root}/:artifactId/images`, {
			params: artifact,
			query: { type: artifactImageTypeSchema },
			payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
			success: Schema.Struct({ address: Schema.String }).pipe(HttpApiSchema.status(201)),
			error: [BadRequest, PayloadTooLarge, Conflict, ...refused],
		}),
		/** An image kept for a `document` artifact, with its own media type. */
		HttpApiEndpoint.get("image", ARTIFACT_IMAGE_PATH, {
			params: image,
			success: HttpApiSchema.StreamUint8Array(),
			error: refused,
		}),
	)
	.middleware(Session) {}
