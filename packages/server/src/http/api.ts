import { Api } from "@sugabots/contracts/http";

/** The path under the installation's `publicUrl` the API answers at, better-auth's routes included. */
export const API_BASE_PATH = "/api";

/** The API as this server mounts it, under `API_BASE_PATH`. */
export const ServerApi = Api.prefix(API_BASE_PATH);
