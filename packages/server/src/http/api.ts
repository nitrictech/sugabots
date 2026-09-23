import { Api } from "@sugabots/contracts/http";
import { API_BASE_PATH } from "../config.ts";

/** The API as this server mounts it, under `API_BASE_PATH`. */
export const ServerApi = Api.prefix(API_BASE_PATH);
