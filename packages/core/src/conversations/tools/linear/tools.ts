import { connectionToolKey } from "@sugabots/contracts";
import type { ConnectionTarget } from "../../../providers/connections/connection-target.ts";
import { type SignedUpload, signedUploadTool, type UploadSide } from "../signed-upload/tool.ts";

/** Where Linear's `prepare_attachment_upload` and `prepare_file_upload` sign uploads to. */
const LINEAR_UPLOAD_DESTINATION = "https://storage.googleapis.com/uploads.linear.app/";

/** The tools of the `linear` augmentation, for the Linear connection `target`. */
export const linearAugmentationTools = {
	upload_file: (target: ConnectionTarget, side: UploadSide) =>
		signedUploadTool(linearUploads(target.handle), side),
};

/** Linear's signed uploads, told by the keys of the connection `handle`'s own tools. */
function linearUploads(handle: string): SignedUpload {
	const key = (name: string) => connectionToolKey(handle, name);
	return {
		destination: LINEAR_UPLOAD_DESTINATION,
		howTo: `Get the URL and headers from ${key("prepare_attachment_upload")}, to attach the file to an issue, or ${key("prepare_file_upload")}, to embed it in a comment or description, and upload straight after: the URL lasts a minute. Then finish with ${key("create_attachment_from_upload")}, or by putting the markdown it gave you where it goes.`,
	};
}
