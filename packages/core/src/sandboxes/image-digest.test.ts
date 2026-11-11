import { describe, expect, it } from "vitest";
import type { EgressHttpClients } from "../providers/network/egress.ts";
import { pinnedToDigest } from "./image-digest.ts";

/**
 * Pinning an image to its digest against a real registry: Sugabots' own app
 * image on GHCR, public, as the sandbox image is once published.
 */
const unbound: EgressHttpClients = { for: () => fetch };

describe.skipIf(!process.env.REGISTRY_TESTS)("pinning an image to its digest, against GHCR", () => {
	it("asks the registry what the tag names now", async () => {
		const pinned = await pinnedToDigest("ghcr.io/nitrictech/sugabots:latest", unbound);

		expect(pinned).toMatch(/^ghcr\.io\/nitrictech\/sugabots@sha256:[0-9a-f]{64}$/);
	});

	it("says nothing of an image the registry doesn't have", async () => {
		expect(
			await pinnedToDigest("ghcr.io/nitrictech/no-such-image:latest", unbound),
		).toBeUndefined();
	});
});
