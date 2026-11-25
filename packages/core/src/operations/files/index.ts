import { listWritten, readWritten } from "./read.ts";
import { edit, write } from "./write.ts";

export const filesOperations = {
	"files.listWritten": listWritten,
	"files.readWritten": readWritten,
	"files.write": write,
	"files.edit": edit,
};
