import { config } from "zod";

/**
 * zod speeds up object parsing by compiling code with `new Function`, and
 * probes for that ability when an object schema is built. The guest site's
 * content security policy forbids eval, so the probe alone is reported as a
 * violation. Turning JIT off skips the probe. Schemas are built when their
 * module loads, so this module must be the first import in main.tsx, ahead of
 * anything that imports @tidegrid/contracts.
 */
config({ jitless: true });
