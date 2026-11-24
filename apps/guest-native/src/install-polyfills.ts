import { config } from "zod";
import { installTextPolyfills } from "./text-polyfill.ts";

installTextPolyfills();
/**
 * zod probes for `new Function` when an object schema is built. In a browser
 * (the phone app demo) the page's policy forbids eval, so the probe alone is
 * a policy violation. Turning JIT off skips it, as the guest site does
 * (apps/guest-site/src/zod-jitless.ts). Schemas are built when their module
 * loads, and this module runs first.
 */
config({ jitless: true });
