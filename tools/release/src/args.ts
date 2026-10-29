import { Refusal } from "./core.ts";

/** Flags that take no value. Every other --flag takes the next argument. */
const booleanFlags = new Set([
  "live",
  "offline",
  "network",
  "dry-run",
  "rollback",
  "kill-switch",
  "again",
  "frozen",
  "allow-branch",
  "skip-build",
  "list",
  "resend",
  "verify",
  "help",
]);

export interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--api-key" || arg.startsWith("--api-key=")) {
      throw new Refusal("--api-key is refused in any argv");
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq > 0 ? eq : undefined);
    if (eq > 0) flags.set(name, arg.slice(eq + 1));
    else if (booleanFlags.has(name)) flags.set(name, true);
    else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Refusal(`--${name} needs a value`);
      flags.set(name, value);
      i++;
    }
  }
  return { positional, flags };
}

export function flag(args: Args, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

export function has(args: Args, name: string): boolean {
  return args.flags.has(name);
}

/** Refuse flags a command does not know, so a typo never silently means "dry run". */
export function onlyFlags(args: Args, allowed: readonly string[]): void {
  for (const name of args.flags.keys()) {
    if (!allowed.includes(name)) throw new Refusal(`unknown option --${name}`);
  }
}
