import { API_BASE_PATH, Api } from "@sugabots/contracts/http";

/** The API as this server mounts it, under `API_BASE_PATH`. */
export const ServerApi = Api.prefix(API_BASE_PATH);
