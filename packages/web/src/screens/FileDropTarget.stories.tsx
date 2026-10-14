import { expect, fn } from "storybook/test";
import preview from "#storybook/preview";
import { FileDropTarget } from "./FileDropTarget.tsx";

/*
 * The chat below its header takes files dragged onto it. Stories drag a file
 * in by dispatching the browser's own drag events.
 */
const meta = preview.meta({
	title: "Product/FileDropTarget",
	component: FileDropTarget,
	tags: ["ai-generated"],
	args: {
		onDropFiles: fn(),
		className: "flex h-[420px] flex-col rounded-xl border bg-background",
		children: (
			<div className="flex flex-1 items-end p-5 text-muted-foreground">
				The chat's messages and composer sit here.
			</div>
		),
	},
});

const report = new File(["%PDF"], "acme-retail-request.pdf", { type: "application/pdf" });

function drag(type: "dragenter" | "dragover" | "drop", target: Element): void {
	const dataTransfer = new DataTransfer();
	dataTransfer.items.add(report);
	target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
}

/** Files dragged over the area: a veil across all of it says where they go and the limits. */
export const FilesOver = meta.story({
	play: async ({ canvas }) => {
		drag("dragenter", canvas.getByText("The chat's messages and composer sit here."));
		await expect(await canvas.findByText("Drop files to attach")).toBeVisible();
		await expect(canvas.getByText("Up to 20 files, 30 MB each")).toBeVisible();
	},
});

/** Dropped, the files are attached and the veil goes. */
export const Dropped = meta.story({
	play: async ({ args, canvas }) => {
		const content = canvas.getByText("The chat's messages and composer sit here.");
		drag("dragenter", content);
		await canvas.findByText("Drop files to attach");
		drag("drop", content);
		await expect(args.onDropFiles).toHaveBeenCalledWith([report]);
		await expect(canvas.queryByText("Drop files to attach")).not.toBeInTheDocument();
	},
});
