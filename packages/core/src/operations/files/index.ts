import { listWritten, readWritten } from "./read.ts";
import { servePage } from "./serve-page.ts";
import { edit, write } from "./write.ts";

export const filesOperations = {
	"files.servePage": servePage,
	"files.listWritten": listWritten,
	"files.readWritten": readWritten,
	"files.write": write,
	"files.edit": edit,
};
