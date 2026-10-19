import { Electroview } from "electrobun/view";
import { SERVER_CHECK_TIMEOUT_MS, type SetupRPC } from "../shared/rpc.ts";

const rpc = Electroview.defineRPC<SetupRPC>({
	handlers: {},
	// Connecting waits on the server's answer, which the main process gives up on after this.
	maxRequestTime: SERVER_CHECK_TIMEOUT_MS + 5_000,
});
new Electroview({ rpc });

const form = element("#connect", HTMLFormElement);
const address = element("#address", HTMLInputElement);
const error = element("#error", HTMLParagraphElement);
const submit = element("#connect button", HTMLButtonElement);

rpc.request.currentServer().then((server) => {
	address.value = server ?? "";
	address.select();
});

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	submit.disabled = true;
	submit.textContent = "Connecting…";
	const result = await rpc.request.connect({ address: address.value });
	if (result.ok) return;
	error.textContent = result.message;
	address.setAttribute("aria-invalid", "true");
	submit.disabled = false;
	submit.textContent = "Connect";
	address.focus();
});

address.addEventListener("input", () => {
	error.textContent = "";
	address.removeAttribute("aria-invalid");
});

function element<T extends Element>(selector: string, type: new () => T): T {
	const found = document.querySelector(selector);
	if (!(found instanceof type)) throw new Error(`index.html has no ${selector}`);
	return found;
}
