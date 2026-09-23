import { createRequire } from "node:module";
import type { HealthResponse } from "@sugabots/contracts";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export const VERSION = version;

export function health(): HealthResponse {
	return { status: "ok", version: VERSION };
}
