/** Join class names, skipping empty values. */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter((n): n is string => typeof n === "string" && n.length > 0).join(" ");
}
