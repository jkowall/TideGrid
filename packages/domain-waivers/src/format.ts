/**
 * Instants as a person reads them, on the marina's clock, for the signing
 * page, the email, and the PDF. Plain text from Intl; the PDF turns the
 * no-break spaces some runtimes use into plain spaces.
 */

export function formatInstant(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at);
}

export function iso(value: Date | string): string {
  return (typeof value === "string" ? new Date(value) : value).toISOString();
}

/**
 * How a typed name is compared with the name on the booking: Unicode NFKC,
 * case folded, and spacing collapsed, so "zoë  example" matches "Zoë Example".
 */
export function comparableName(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

/** A single line of text as stored: NFC, spacing collapsed, trimmed. */
export function cleanLine(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}
