import type { ToolCallPart } from "@sugabots/contracts";
import { cn } from "cn";
import { FileText, PanelsTopLeft } from "lucide-react";

/** The tools whose result is an artifact written, as `artifactWritten` reads it. */
const WRITING_TOOLS = new Set(["artifact_create", "artifact_replace", "document_replace_section"]);

interface WrittenArtifact {
	artifactId: string;
	kind: "document" | "html";
	title: string;
	version: number;
}

/**
 * The artifacts a reply's calls wrote, as cards under its tool line, so a
 * document a bot made is one click from the conversation that asked for it.
 */
export function ArtifactCards({
	calls,
	onOpen,
	className,
}: {
	calls: readonly ToolCallPart[];
	onOpen: (artifactId: string) => void;
	className?: string;
}) {
	const written = writtenBy(calls);
	if (written.length === 0) return null;
	return (
		<ul className={cn("m-0 flex list-none flex-col items-start gap-1.5 pb-1.5", className)}>
			{written.map((artifact) => {
				const Icon = artifact.kind === "html" ? PanelsTopLeft : FileText;
				return (
					<li key={artifact.artifactId}>
						<button
							type="button"
							onClick={() => onOpen(artifact.artifactId)}
							className="focus-ring flex max-w-[420px] items-center gap-2.5 rounded-[14px] border border-border bg-list px-3 py-2 text-left transition-colors hover:bg-hover"
						>
							<Icon aria-hidden size={18} className="shrink-0 text-soft-foreground" />
							<span className="flex min-w-0 flex-col">
								<span className="truncate font-semibold text-foreground text-sm">
									{artifact.title}
								</span>
								<span className="text-[12.5px] text-muted-foreground">
									{artifact.kind === "html" ? "Page" : "Document"} · version {artifact.version}
								</span>
							</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
}

/** Each artifact the calls wrote, once, at the last version they wrote. */
function writtenBy(calls: readonly ToolCallPart[]): WrittenArtifact[] {
	const latest = new Map<string, WrittenArtifact>();
	for (const call of calls) {
		if (call.status !== "completed" || !WRITING_TOOLS.has(call.tool)) continue;
		const artifact = artifactWritten(call.output);
		if (artifact) latest.set(artifact.artifactId, artifact);
	}
	return [...latest.values()];
}

/** The artifact a writing tool's `{ status: "written", ... }` result names, if it is one. */
function artifactWritten(output: unknown): WrittenArtifact | undefined {
	if (typeof output !== "object" || output === null) return undefined;
	const result = output as Record<string, unknown>;
	if (
		result.status !== "written" ||
		typeof result.artifactId !== "string" ||
		(result.kind !== "document" && result.kind !== "html") ||
		typeof result.title !== "string" ||
		typeof result.version !== "number"
	) {
		return undefined;
	}
	return {
		artifactId: result.artifactId,
		kind: result.kind,
		title: result.title,
		version: result.version,
	};
}
