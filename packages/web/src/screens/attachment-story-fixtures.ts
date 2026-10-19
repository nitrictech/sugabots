import { MAX_ATTACHMENTS_PER_MESSAGE } from "@sugabots/contracts";
import type { AttachmentUpload, ComposerAttachment } from "@/lib/composer-attachments.ts";

/*
 * Files attached in the composer, for stories: each in a fixed state, so
 * every run draws the same chips.
 */

/** A small drawing of a pricing page, so an image's thumbnail is the same in every run. */
const PRICING_PAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
<rect width="320" height="240" fill="#f5f3ee"/>
<rect x="24" y="24" width="132" height="14" rx="4" fill="#2f323a"/>
<rect x="24" y="48" width="208" height="8" rx="3" fill="#b9bcc4"/>
<rect x="24" y="84" width="84" height="124" rx="8" fill="#ffffff" stroke="#d4d6dc"/>
<rect x="118" y="76" width="84" height="140" rx="8" fill="#4f5bd5"/>
<rect x="212" y="84" width="84" height="124" rx="8" fill="#ffffff" stroke="#d4d6dc"/>
<rect x="36" y="100" width="44" height="12" rx="3" fill="#2f323a"/>
<rect x="130" y="94" width="44" height="12" rx="3" fill="#ffffff"/>
<rect x="224" y="100" width="44" height="12" rx="3" fill="#2f323a"/>
</svg>`;

let nextKey = 0;

function attached(file: File, upload: AttachmentUpload): ComposerAttachment {
	nextKey += 1;
	return { key: `story-attachment-${nextKey}`, file, upload };
}

function storyFile(name: string, type: string, content = "Story fixture"): File {
	return new File([content], name, { type, lastModified: 0 });
}

const pricingPage = storyFile("pricing-page-new.svg", "image/svg+xml", PRICING_PAGE_SVG);
const done = (fileId: string): AttachmentUpload => ({ state: "uploaded", fileId });

export const pricingPageUploading = attached(pricingPage, { state: "uploading", progress: 0.64 });
export const pricingPageReady = attached(pricingPage, done("0199a3a0-0000-7000-8000-000000000a01"));
export const acmeRequest = attached(
	storyFile("acme-retail-request.pdf", "application/pdf"),
	done("0199a3a0-0000-7000-8000-000000000a02"),
);
export const callRecordingTooLarge = attached(storyFile("sales-call-recording.mp4", "video/mp4"), {
	state: "tooLarge",
});
export const boardPackFailed = attached(storyFile("q3-board-pack-v2.pdf", "application/pdf"), {
	state: "failed",
	reason: "The upload didn't finish. Check your connection and retry.",
	retryable: true,
});
/** Refused by the API for its type, so trying it again would only be refused again. */
export const installerRefused = attached(
	storyFile("setup-helper.exe", "application/x-msdownload"),
	{ state: "failed", reason: "This kind of file can't be attached.", retryable: false },
);
export const brandGuideUploading = attached(storyFile("brand-guide.key", ""), {
	state: "uploading",
	progress: 0.12,
});
export const pipelineSheet = attached(
	storyFile("q4-pipeline.csv", "text/csv"),
	done("0199a3a0-0000-7000-8000-000000000a03"),
);
export const signedOrderForm = attached(
	storyFile("northwind-labs-signed-order-form.pdf", "application/pdf"),
	done("0199a3a0-0000-7000-8000-000000000a04"),
);

/** As many invoices as one message can carry. */
export const invoicesAtLimit = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, index) =>
	attached(
		storyFile(`invoice-${1041 + index}.pdf`, "application/pdf"),
		done(`0199a3a0-0000-7000-8000-000000000b${String(index).padStart(2, "0")}`),
	),
);
