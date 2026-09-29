import { BotFace, type BotLook } from "@sugabots/avatars";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

/** The side of a face drawn as an icon, in pixels: the size notices show icons at, doubled. */
const ICON_SIZE = 192;

/**
 * A bot's face as a PNG data URL, for an image that must be a raster, such as
 * a desktop notice's icon. Drawn from `BotFace`, so it is the face the app
 * shows everywhere else.
 */
export async function faceIcon(look: BotLook): Promise<string> {
	const holder = document.createElement("div");
	const root = createRoot(holder);
	flushSync(() =>
		root.render(
			<BotFace {...look} xmlns="http://www.w3.org/2000/svg" width={ICON_SIZE} height={ICON_SIZE} />,
		),
	);
	const svg = holder.innerHTML;
	root.unmount();

	const image = new Image();
	image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	await image.decode();
	const canvas = document.createElement("canvas");
	canvas.width = ICON_SIZE;
	canvas.height = ICON_SIZE;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("The browser gave no canvas to draw the face on");
	context.drawImage(image, 0, 0, ICON_SIZE, ICON_SIZE);
	return canvas.toDataURL("image/png");
}
