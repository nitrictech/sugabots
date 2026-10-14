import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import {
	acmeRequest,
	boardPackFailed,
	brandGuideUploading,
	callRecordingTooLarge,
	installerRefused,
	pipelineSheet,
	pricingPageReady,
	pricingPageUploading,
	signedOrderForm,
} from "./attachment-story-fixtures.ts";
import { AttachmentChip } from "./ComposerAttachments.tsx";

/*
 * A file attached in the composer, at size, on the message box's surface.
 * Pointing at one shows its name and how its upload stands; every chip keeps
 * its remove button.
 */
const meta = preview.meta({
	title: "Product/AttachmentChip",
	component: AttachmentChip,
	tags: ["ai-generated"],
	args: { attachment: acmeRequest, onRemove: fn(), onRetry: fn() },
	decorators: [
		(Story) => (
			<ul aria-label="Attached files" className="m-0 flex list-none rounded-xl bg-panel p-4">
				<Story />
			</ul>
		),
	],
});

/** An image uploading: its thumbnail faded until done, with a bar filling along the foot. */
export const ImageUploading = meta.story({
	args: { attachment: pricingPageUploading },
	play: async ({ canvas }) => {
		await expect(canvas.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "64");
	},
});

/** Another kind of file uploading: a file icon, with its extension as the badge. */
export const FileUploading = meta.story({ args: { attachment: brandGuideUploading } });

/** An image uploaded: the thumbnail is the image, cropped to fill. */
export const ImageReady = meta.story({ args: { attachment: pricingPageReady } });

/** A PDF uploaded: a page, badged in grey, since red is kept for errors. */
export const PdfReady = meta.story({});

/** A sheet uploaded: a ruled page, badged in green. */
export const SheetReady = meta.story({ args: { attachment: pipelineSheet } });

/** Too large to upload, which is checked first, so nothing was sent. Remove is all it offers. */
export const TooLarge = meta.story({
	args: { attachment: callRecordingTooLarge },
	play: async ({ canvas }) => {
		await expect(canvas.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
	},
});

/** An upload that failed but could work if tried again: Retry starts it again on the same chip. */
export const UploadFailed = meta.story({
	args: { attachment: boardPackFailed },
	play: async ({ args, canvas, userEvent }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Retry q3-board-pack-v2.pdf" }));
		await expect(args.onRetry).toHaveBeenCalledOnce();
	},
});

/** A file the API refused for what it is: trying again would fail the same way, so only remove is offered. */
export const Refused = meta.story({
	args: { attachment: installerRefused },
	play: async ({ canvas }) => {
		await expect(canvas.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
		await expect(
			canvas.getByRole("button", { name: "Remove setup-helper.exe" }),
		).toBeInTheDocument();
	},
});

/**
 * A long name, cut from the middle so its end and extension stay readable.
 * Focusing the remove button shows the name and the button, as pointing does.
 */
export const LongName = meta.story({
	args: { attachment: signedOrderForm },
	play: async ({ args, canvas, userEvent }) => {
		await userEvent.tab();
		const remove = canvas.getByRole("button", {
			name: "Remove northwind-labs-signed-order-form.pdf",
		});
		await expect(remove).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		await expect(args.onRemove).toHaveBeenCalledOnce();
	},
});
