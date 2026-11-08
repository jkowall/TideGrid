import type { RequestOutcome } from "@tidegrid/domain-hostnames";

/** The lines `request` prints, also printed when `release` resumes a request. */
export function requestLines(hostname: string, outcome: RequestOutcome): string[] {
  if (outcome.kind !== "requested") return [`${hostname}: ${outcome.kind}`];
  return [
    `${hostname}: requested${outcome.adopted ? " (adopted after a lost answer)" : ""}`,
    "Publish these records:",
    ...outcome.reading.instructions.map((i) =>
      i.kind === "cname"
        ? `  CNAME ${i.name} -> ${i.target}`
        : i.kind === "txt"
          ? `  TXT ${i.name} "${i.value}" (${i.purpose})`
          : `  HTTP ${i.url} (${i.purpose})`,
    ),
  ];
}
