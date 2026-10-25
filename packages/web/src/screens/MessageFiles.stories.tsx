import type { FilePart } from "@sugabots/contracts";
import { expect, userEvent, waitFor, within } from "storybook/test";
import preview from "#storybook/preview";
import { MessageFiles } from "./MessageFiles.tsx";

/*
 * The files attached to a sent message, under its words: images as pictures
 * that open full size over the chat, and other files as chips to download.
 */

/** A picture drawn as an SVG, so the stories need no server and look the same every run. */
function pictureUrl(label: string, hue: number): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><rect width="640" height="420" fill="hsl(${hue} 45% 32%)"/><text x="320" y="220" font-family="sans-serif" font-size="40" fill="white" text-anchor="middle">${label}</text></svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function file(id: number, name: string, contentType: string, size: number): FilePart {
	return {
		type: "file",
		id: `0199a3a0-0000-7000-8000-0000000002${String(id).padStart(2, "0")}`,
		name,
		contentType,
		size,
	};
}

const oldPricing = file(1, "pricing-page-old.png", "image/png", 412_000);
const newPricing = file(2, "pricing-page-new.png", "image/png", 398_000);
const acmeEmail = file(3, "acme-email.png", "image/png", 220_000);
const acmeRequest = file(4, "acme-retail-request.pdf", "application/pdf", 245_760);
const pipeline = file(5, "q4-pipeline.csv", "text/csv", 18_400);
const brandGuide = file(
	6,
	"northwind-labs-brand-guide-final-v3.key",
	"application/octet-stream",
	8_900_000,
);

const pictures = new Map(
	[oldPricing, newPricing, acmeEmail].map((picture, index) => [
		picture.id,
		pictureUrl(picture.name.replace(".png", ""), 200 + index * 50),
	]),
);
// Bytes no browser can draw, so the image falls back without asking any server.
const undrawable = "data:image/heic;base64,AAAAGGZ0eXBoZWljAAAAAA==";
const urlOf = (fileId: string) =>
	pictures.get(fileId) ?? (fileId.endsWith("07") ? undrawable : `/files/${fileId}`);

/** An image the browser can't draw: a HEIC photo, which falls back to its name and an icon. */
const holidayPhoto = file(7, "holiday.heic", "image/heic", 2_400_000);

const meta = preview.meta({
	title: "Product/MessageFiles",
	component: MessageFiles,
	tags: ["ai-generated"],
	args: { files: [acmeRequest], urlOf },
	decorators: [
		(Story) => (
			<div className="max-w-[640px] bg-background p-5">
				<Story />
			</div>
		),
	],
});

/** One image, fitted to a 4:3 frame, with a download button over its corner. */
export const OneImage = meta.story({
	args: { files: [newPricing] },
	play: async ({ canvas }) => {
		await expect(
			canvas.getByRole("link", { name: "Download pricing-page-new.png" }),
		).toHaveAttribute("download", "pricing-page-new.png");
	},
});

/** An image opened over the chat, as large as the window allows, to download or close. */
export const ImageOpened = meta.story({
	args: { files: [newPricing] },
	play: async ({ canvas, canvasElement }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Open pricing-page-new.png" }));
		const viewer = within(canvasElement.ownerDocument.body).getByRole("dialog");
		await expect(within(viewer).getByRole("img", { name: "pricing-page-new.png" })).toBeVisible();
		await expect(
			within(viewer).getByRole("link", { name: "Download pricing-page-new.png" }),
		).toHaveAttribute("download", "pricing-page-new.png");

		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(viewer).not.toBeInTheDocument());
	},
});

/** Two images, side by side. */
export const TwoImages = meta.story({ args: { files: [oldPricing, newPricing] } });

/** Three images and a PDF. */
export const ImagesAndAFile = meta.story({
	args: { files: [oldPricing, newPricing, acmeEmail, acmeRequest] },
	play: async ({ canvas }) => {
		await expect(canvas.getAllByRole("button", { name: /^Open / })).toHaveLength(3);
		await expect(
			canvas.getByRole("link", { name: "Download acme-retail-request.pdf" }),
		).toHaveAttribute("download", "acme-retail-request.pdf");
	},
});

/** An image opened from several, stepped through with the arrows and the arrow keys, round from the last to the first. */
export const ImagesSteppedThrough = meta.story({
	args: { files: [oldPricing, newPricing, acmeEmail] },
	play: async ({ canvas, canvasElement }) => {
		await userEvent.click(canvas.getByRole("button", { name: "Open pricing-page-new.png" }));
		const viewer = within(canvasElement.ownerDocument.body).getByRole("dialog");
		await expect(within(viewer).getByText("2 of 3")).toBeVisible();

		await userEvent.click(within(viewer).getByRole("button", { name: "Next image" }));
		await expect(within(viewer).getByRole("img", { name: "acme-email.png" })).toBeVisible();
		await userEvent.click(within(viewer).getByRole("button", { name: "Next image" }));
		await expect(within(viewer).getByText("1 of 3")).toBeVisible();

		await userEvent.keyboard("{ArrowLeft}");
		await expect(within(viewer).getByRole("img", { name: "acme-email.png" })).toBeVisible();
	},
});

/** Files only: a sheet, and a file with a long name cut in its middle so its end stays. */
export const FilesOnly = meta.story({
	args: { files: [pipeline, brandGuide] },
	play: async ({ canvas }) => {
		await expect(canvas.getByText("CSV · 18 KB")).toBeVisible();
		await expect(canvas.getByText("KEY · 8.5 MB")).toBeVisible();
	},
});

/** On a phone: images three to a row across the width, and chips as wide as the message. */
export const OnAPhone = meta.story({
	args: { files: [oldPricing, newPricing, acmeEmail, acmeRequest, pipeline] },
	globals: { viewport: { value: "iphone12", isRotated: false } },
});

/** An image the browser can't draw shows its name and an icon, and opens to be downloaded. */
export const ImageThatWontDraw = meta.story({
	args: { files: [holidayPhoto] },
	play: async ({ canvas, canvasElement }) => {
		const open = canvas.getByRole("button", { name: "Open holiday.heic" });
		await waitFor(() => expect(open.querySelector("img")).toBeNull());

		await userEvent.click(open);
		const viewer = within(canvasElement.ownerDocument.body).getByRole("dialog");
		await expect(await within(viewer).findByText(/can't be shown here/)).toBeVisible();
	},
});
