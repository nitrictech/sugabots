/**
 * The host request tool's name. It lives apart from the tool, with nothing
 * imported, because deciding who approves a call needs only the name, and
 * importing the tool would pull the computer modules in, whose import cycle
 * can leave the name undefined while the module that reads it loads.
 */
export const HOST_REQUEST_TOOL = "request_host";
