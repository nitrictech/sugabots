import { connectionPresetFor } from "@sugabots/contracts";
import type { ConnectionAugmentation } from "../augmentations.ts";

/** Linear's augmentation: uploading a file to the place its server reserved for it, which its own tools can't do. */
export const linearAugmentation = {
	appliesTo: (connection) => connectionPresetFor(connection.url)?.id === "linear",
	tools: {
		upload_file: {
			description:
				"Upload a file from the thread or the sandbox to a URL Linear signed, to attach it to an issue or embed it.",
			readOnly: false,
			destructive: false,
			// Linear's prepare step, which asks, is where a file is decided on; the
			// upload only fills the place it reserved. A person asked again would
			// rarely answer within the minute the URL lasts.
			defaultAccess: "allow",
		},
	},
} satisfies ConnectionAugmentation;
