import { describe, expect, it } from "vitest";
import {
	artifactImageAddress,
	artifactImageAt,
	artifactImageIds,
	ownImageAt,
} from "./artifact-images.ts";

const ids = {
	podId: "0199a3a0-0000-7000-8000-000000000001",
	artifactId: "0199a3a0-0000-7000-8000-000000000002",
	imageId: "a".repeat(64),
};

function checked(raw: typeof ids) {
	const made = artifactImageIds(raw);
	if (!made) throw new Error("fixture");
	return made;
}

describe("an image's address", () => {
	it("reads back as the image it was made for", () => {
		const address = artifactImageAddress(checked(ids));

		expect(address).toBe(
			`/api/pods/${ids.podId}/artifacts/${ids.artifactId}/images/${ids.imageId}`,
		);
		expect(artifactImageAt(address)).toEqual(ids);
	});

	it("is made of ids of an address's form only", () => {
		expect(artifactImageIds({ ...ids, podId: "a/../b" })).toBeUndefined();
		expect(artifactImageIds({ ...ids, imageId: "../versions" })).toBeUndefined();
		expect(artifactImageIds({ ...ids, imageId: ids.imageId.toUpperCase() })).toBeUndefined();
	});

	it("names no image in any other form, as no route serves it", () => {
		const address = artifactImageAddress(checked(ids));

		expect(artifactImageAt(address.toUpperCase())).toBeUndefined();
		expect(artifactImageAt(`${address}?size=large`)).toBeUndefined();
		expect(artifactImageAt(`https://example.com${address}`)).toBeUndefined();
	});

	it("is a document's own only when it names that document", () => {
		const address = artifactImageAddress(checked(ids));
		const elsewhere = artifactImageAddress(
			checked({ ...ids, artifactId: "0199a3a0-0000-7000-8000-000000000009" }),
		);

		expect(ownImageAt(address, ids)).toEqual(ids);
		expect(ownImageAt(elsewhere, ids)).toBeUndefined();
	});
});
