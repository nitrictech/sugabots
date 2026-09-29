import { cn } from "cn";
import { CheckIcon, MinusIcon } from "lucide-react";
import { useState } from "react";

const roles = {
	owner: {
		label: "Owner",
		summary: "Administers the workspace, decides who else does, and can hand it on.",
	},
	admin: {
		label: "Admin",
		summary: "Administers the workspace, its providers and every shared pod.",
	},
	member: { label: "Member", summary: "Builds agents in the pods they are added to." },
	viewer: { label: "Viewer", summary: "Reads and takes part in the pods they are added to." },
} as const;

type Role = keyof typeof roles;

interface Ability {
	label: string;
	roles: readonly Role[];
	/** When the answer depends on something, like which pods you're in. */
	note?: string;
}

/** What each role may do, as packages/core/src/authorization/permissions.ts grants it. */
const abilities: readonly Ability[] = [
	{
		label: "Chat with bots",
		roles: ["owner", "admin", "member", "viewer"],
		note: "In pods they're in; the owner and admins reach every shared pod",
	},
	{ label: "Create and edit bots", roles: ["owner", "admin", "member"] },
	{ label: "Answer a bot's approval in a chat", roles: ["owner", "admin", "member"] },
	{ label: "Delete bots", roles: ["owner", "admin"] },
	{ label: "Create pods", roles: ["owner", "admin"] },
	{ label: "Add and manage connections", roles: ["owner", "admin"] },
	{ label: "Create and manage routines", roles: ["owner", "admin"] },
	{ label: "Answer approvals from routine runs", roles: ["owner", "admin"] },
	{ label: "Connect models and web search", roles: ["owner", "admin"] },
	{ label: "Invite and manage members and viewers", roles: ["owner", "admin"] },
	{ label: "Make, unmake and remove admins", roles: ["owner"] },
	{ label: "Transfer ownership", roles: ["owner"] },
];

/** Who can do what, with a role to pick out. */
export function RoleMatrix() {
	const [picked, setPicked] = useState<Role>("member");
	return (
		<div className="my-8 flex flex-col gap-4">
			<fieldset className="flex flex-wrap gap-2">
				<legend className="sr-only">Role</legend>
				{(Object.keys(roles) as Role[]).map((role) => (
					<button
						key={role}
						type="button"
						aria-pressed={role === picked}
						onClick={() => setPicked(role)}
						className={cn(
							"rounded-full border-2 px-3.5 py-1 text-sm font-semibold transition-colors",
							role === picked
								? "border-brand bg-brand text-brand-foreground"
								: "border-input text-muted-foreground hover:text-foreground",
						)}
					>
						{roles[role].label}
					</button>
				))}
			</fieldset>
			<p className="text-sm text-muted-foreground">
				<span className="font-semibold text-foreground">{roles[picked].label}:</span>{" "}
				{roles[picked].summary}
			</p>
			<ul className="flex flex-col divide-y rounded-2xl ring-1 ring-foreground/10">
				{abilities.map((ability) => {
					const allowed = ability.roles.includes(picked);
					return (
						<li
							key={ability.label}
							className={cn(
								"flex items-center gap-3 px-4 py-3 transition-opacity",
								!allowed && "opacity-45",
							)}
						>
							<span
								className={cn(
									"flex size-6 shrink-0 items-center justify-center rounded-full",
									allowed ? "bg-green-500 text-white" : "bg-muted text-muted-foreground",
								)}
							>
								{allowed ? <CheckIcon className="size-3.5" /> : <MinusIcon className="size-3.5" />}
							</span>
							<span className="flex flex-col">
								<span className="font-medium">{ability.label}</span>
								{ability.note && (
									<span className="text-xs text-muted-foreground">{ability.note}</span>
								)}
							</span>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
