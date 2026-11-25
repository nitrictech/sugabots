import { Popover } from "@base-ui/react/popover";
import type { Pod } from "@sugabots/contracts";
import {
	Check,
	Download,
	Link2,
	Lock,
	type LucideIcon,
	Presentation,
	Printer,
	Users,
	X,
} from "lucide-react";
import { useState } from "react";
import { downloadLiveArtifactFile } from "@/lib/artifacts.ts";
import { Button } from "@/ui/button.tsx";
import { iconButtonClassName } from "@/ui/icon-button.tsx";
import { SegmentedControl } from "@/ui/segmented-control.tsx";
import { useCopy } from "@/ui/use-copy.ts";

/** A file an artifact can be saved as. */
export interface ExportOption {
	/** What the file is, such as "Word". */
	label: string;
	/** What the person gets, such as "Editable .docx document". */
	description: string;
	Icon: LucideIcon;
	onSave: () => void;
}

/** A deck saved as a PowerPoint file or a PDF, which the API builds from its current, live state. */
export const deckExports = (podId: string, artifactId: string): ExportOption[] => [
	{
		label: "PowerPoint",
		description: "Editable .pptx presentation",
		Icon: Presentation,
		onSave: () => downloadLiveArtifactFile(podId, artifactId, "powerpoint"),
	},
	{
		label: "PDF",
		description: ".pdf file to share or print",
		Icon: Printer,
		onSave: () => downloadLiveArtifactFile(podId, artifactId, "pdf"),
	},
];

/**
 * Who can open an artifact and how to hand it on: its link, for the people
 * who can already open it, and the files it can be saved as, for everyone else.
 * The lock says it is not open to the world, which no artifact is.
 */
export function ArtifactShare({
	title,
	pod,
	link,
	exports,
}: {
	title: string;
	pod: Pod;
	/** The artifact's address in the app. */
	link: () => string;
	exports: readonly ExportOption[];
}) {
	const [showing, setShowing] = useState<"share" | "export">("share");
	const copying = useCopy("Copy link");
	return (
		<Popover.Root>
			<Popover.Trigger className="focus-ring inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-border-strong bg-chip px-2.5 font-medium text-foreground text-xs transition-colors hover:bg-hover data-popup-open:bg-hover">
				<Lock aria-hidden size={13} />
				Share
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner side="bottom" align="end" sideOffset={6} className="isolate z-50">
					<Popover.Popup className="flex w-88 max-w-(--available-width) flex-col gap-3 rounded-xl border border-border-strong bg-panel p-3 text-foreground shadow-popover outline-none">
						<div className="flex items-center gap-2">
							<Popover.Title className="m-0 min-w-0 flex-1 truncate font-medium text-sm">
								{title}
							</Popover.Title>
							<Popover.Close aria-label="Close" className={iconButtonClassName()}>
								<X aria-hidden className="size-3.5" />
							</Popover.Close>
						</div>
						<SegmentedControl
							label="Share or export"
							options={SHOWING}
							value={showing}
							onChange={setShowing}
							className="w-full [&>label]:flex-1 [&>label]:text-center"
						/>
						{showing === "share" ? (
							<div className="flex gap-3 rounded-xl bg-chip p-3">
								<Users aria-hidden size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
								<div className="flex min-w-0 flex-col items-start gap-2">
									<p className="m-0 font-medium text-sm">
										{pod.kind === "personal"
											? "Only you can open this"
											: `Only members of ${pod.name} can open this`}
									</p>
									<p className="m-0 text-muted-foreground text-xs">
										{pod.kind === "personal"
											? "It is in your Personal pod. The link works for you and nobody else."
											: "That is the people added to the pod, and the workspace's admins. The link works for them and nobody else."}
									</p>
									<Button size="sm" className="gap-1.5" onClick={() => void copying.copy(link())}>
										{copying.copied ? (
											<Check aria-hidden size={13} />
										) : (
											<Link2 aria-hidden size={13} />
										)}
										{copying.label}
									</Button>
								</div>
							</div>
						) : (
							<ul className="m-0 flex list-none flex-col p-0">
								{exports.map(({ label, description, Icon, onSave }) => (
									<li key={label}>
										<button
											type="button"
											onClick={onSave}
											className="focus-ring flex w-full items-center gap-3 rounded-lg p-1.5 text-left transition-colors hover:bg-hover"
										>
											<span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground">
												<Icon aria-hidden size={16} />
											</span>
											<span className="flex min-w-0 flex-1 flex-col">
												<span className="font-medium text-sm">{label}</span>
												<span className="truncate text-muted-foreground text-xs">
													{description}
												</span>
											</span>
											<Download aria-hidden size={15} className="shrink-0 text-muted-foreground" />
										</button>
									</li>
								))}
							</ul>
						)}
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}

const SHOWING = [
	{ value: "share", label: "Share" },
	{ value: "export", label: "Export" },
] as const;
