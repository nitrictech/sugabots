import { Electroview } from "electrobun/view";
import type { ApprovalRPC } from "../shared/rpc.ts";

const rpc = Electroview.defineRPC<ApprovalRPC>({ handlers: {} });
new Electroview({ rpc });

const deny = element("#deny", HTMLButtonElement);
const allow = element("#allow", HTMLButtonElement);

rpc.request.command().then(({ command, cwd }) => {
	element("#command", HTMLPreElement).textContent = command;
	element("#cwd", HTMLSpanElement).textContent = cwd;
	// Deny is the default, so a stray Enter never runs a command.
	deny.focus();
});

const decide = (approved: boolean) => {
	deny.disabled = true;
	allow.disabled = true;
	rpc.request.decide({ allow: approved });
};
deny.addEventListener("click", () => decide(false));
allow.addEventListener("click", () => decide(true));
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") decide(false);
});

function element<T extends Element>(selector: string, type: new () => T): T {
	const found = document.querySelector(selector);
	if (!(found instanceof type)) throw new Error(`index.html has no ${selector}`);
	return found;
}
