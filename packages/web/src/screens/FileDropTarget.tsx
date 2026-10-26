import { cn } from "cn";
import { Upload } from "lucide-react";
import { type DragEvent, type ReactNode, useRef, useState } from "react";

/**
 * An area that takes files dragged onto it from the computer, such as the
 * whole chat below its header, so a drop that misses the composer still lands.
 * While files are over it, a veil across it says, in `heading` and `detail`,
 * what dropping them does. Without
 * `onDropFiles` it takes nothing, and drags pass over it as usual.
 */
export function FileDropTarget({
	heading,
	detail,
	onDropFiles,
	className,
	children,
}: {
	heading: string;
	detail: ReactNode;
	onDropFiles?: (files: File[]) => void;
	className?: string;
	children: ReactNode;
}) {
	const [filesOver, setFilesOver] = useState(false);
	// Entering a child leaves its parent, so the area is left only once every enter has its leave.
	const enters = useRef(0);
	const takesFiles = (event: DragEvent) =>
		onDropFiles !== undefined && event.dataTransfer.types.includes("Files");

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: dropping is a pointer shortcut; the composer's + and paste attach the same files from a keyboard.
		<div
			className={cn("relative", className)}
			onDragEnter={(event) => {
				if (!takesFiles(event)) return;
				event.preventDefault();
				enters.current += 1;
				setFilesOver(true);
			}}
			onDragOver={(event) => {
				if (!takesFiles(event)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
			}}
			onDragLeave={(event) => {
				if (!takesFiles(event)) return;
				enters.current = Math.max(0, enters.current - 1);
				if (enters.current === 0) setFilesOver(false);
			}}
			onDrop={(event) => {
				if (!takesFiles(event)) return;
				event.preventDefault();
				enters.current = 0;
				setFilesOver(false);
				const files = [...event.dataTransfer.files];
				if (files.length > 0) onDropFiles?.(files);
			}}
		>
			{children}
			{filesOver && (
				<div
					aria-hidden
					className="pointer-events-none absolute inset-0 z-40 flex bg-drop-veil px-5 pt-4 pb-[42px]"
				>
					<div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border-[1.5px] border-ring border-dashed bg-drop-target px-4 text-center">
						<span className="mb-1 grid size-12 place-items-center rounded-tile bg-primary text-primary-foreground">
							<Upload size={22} strokeWidth={2.2} />
						</span>
						<span className="font-semibold text-[17px] text-foreground">{heading}</span>
						<span className="text-[13.5px] text-muted-foreground">{detail}</span>
					</div>
				</div>
			)}
		</div>
	);
}
