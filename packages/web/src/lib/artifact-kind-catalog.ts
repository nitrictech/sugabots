import type { ArtifactKind } from "@sugabots/contracts";

/*
 * What each kind of artifact is called and what Download saves it as. Plain
 * data, which the native apps' copies are generated from; how each kind is
 * drawn is in `screens/artifact-kinds.tsx`. apps/codegen loads this module
 * with Node, so it imports nothing but types.
 */

/** What it is called beside its title, such as "Document". */
export const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
	document: "Document",
	html: "Page",
};

/** How Download saves it: as `type`, ending in `.extension`. */
export const ARTIFACT_KIND_FILES: Record<ArtifactKind, { extension: string; type: string }> = {
	document: { extension: "md", type: "text/markdown" },
	html: { extension: "html", type: "text/html" },
};
