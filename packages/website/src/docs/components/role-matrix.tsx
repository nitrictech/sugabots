import {
	WORKSPACE_ROLES,
	type WorkspaceRole,
	workspaceRoleDescription,
	workspaceRoleLabel,
} from "@sugabots/contracts";
import { roleAbilities } from "@sugabots/docs/roles";
import { cn } from "cn";
import { CheckIcon, MinusIcon } from "lucide-react";
import { useState } from "react";

/** Who can do what, with a role to pick out. */
export function RoleMatrix() {
	const [picked, setPicked] = useState<WorkspaceRole>("member");
	return (
		<div className="my-8 flex flex-col gap-4">
			<fieldset className="flex flex-wrap gap-2">
				<legend className="sr-only">Role</legend>
				{WORKSPACE_ROLES.map((role) => (
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
						{workspaceRoleLabel(role)}
					</button>
				))}
			</fieldset>
			<p className="text-sm text-muted-foreground">
				<span className="font-semibold text-foreground">{workspaceRoleLabel(picked)}:</span>{" "}
				{workspaceRoleDescription(picked)}
			</p>
			<ul className="flex flex-col divide-y rounded-2xl ring-1 ring-foreground/10">
				{roleAbilities.map((ability) => {
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
