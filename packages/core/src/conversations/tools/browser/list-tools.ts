/**
 * Writes `playwright-tools.json`: the tools of the Playwright MCP server in
 * Sugabots' sandbox image, which agents are offered before their browser has
 * started. `bun run build:sandbox` runs it after building the image, so the
 * tools always match the server the image carries.
 */
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SANDBOX_IMAGE } from "@sugabots/contracts";

/** Tools agents aren't offered: arbitrary code, and resizing a window people are watching. */
const LEFT_OUT = new Set(["browser_run_code_unsafe", "browser_resize"]);

const client = new Client({ name: "sugabots-list-tools", version: "1" });
await client.connect(
	new StdioClientTransport({
		command: "docker",
		args: ["run", "--rm", "-i", "--entrypoint", "playwright-mcp", SANDBOX_IMAGE, "--headless"],
	}),
);
const { tools } = await client.listTools();
await client.close();

const offered = tools
	.filter((tool) => !LEFT_OUT.has(tool.name))
	.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
const file = new URL("./playwright-tools.json", import.meta.url);
writeFileSync(file, `${JSON.stringify(offered, null, "\t")}\n`);
console.log(`Wrote ${offered.length} browser tools to ${file.pathname}`);
