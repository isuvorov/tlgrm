// Regenerates config.schema.json from the zod schema — run after changing src/settings/schema.ts.
import { writeFileSync } from "node:fs";
import { configJsonSchema } from "../src/settings/schema.ts";

const target = new URL("../config.schema.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
console.log(`wrote ${target.pathname}`);
