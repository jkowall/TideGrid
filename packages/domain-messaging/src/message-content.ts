/**
 * A message's recipient and content, plain or sealed (0057, W3-OPS-4). Where
 * the transaction has a field keyring, `enqueueMessage` writes the address,
 * name, subject, and bodies sealed in `content_sealed` and the address key in
 * `to_email` (see `addressKey` in @tidegrid/database); the delivery job opens
 * them to send. A plain message passes through as written.
 */
import {
  contactKeysToOpen,
  openContact,
  sealContact,
  type TenantTransaction,
} from "@tidegrid/database";

const PLACE = "email_messages.content_sealed";

export interface MessageContent {
  toEmail: string;
  toName: string | null;
  subject: string;
  html: string;
  text: string;
}

/** Seal a message's recipient and content for its tenant. */
export async function sealMessageContent(
  trx: TenantTransaction,
  tenantId: string,
  content: MessageContent,
): Promise<string> {
  const keyring = await contactKeysToOpen(trx);
  return sealContact(keyring, { tenantId, field: PLACE }, { ...content });
}

/** A message row's recipient and content columns as read. */
export interface MessageContentRow {
  to_email: string;
  to_name: string | null;
  subject: string | null;
  html_body: string | null;
  text_body: string | null;
  content_sealed?: string | null;
}

/** The row with its recipient and content opened in place; a plain row passes through. */
export async function openMessageContent<T extends MessageContentRow>(
  trx: TenantTransaction,
  tenantId: string,
  row: T,
): Promise<T & { subject: string; html_body: string; text_body: string }> {
  if (!row.content_sealed) {
    if (row.subject === null || row.html_body === null || row.text_body === null) {
      throw new Error("a plain message has no content");
    }
    return row as T & { subject: string; html_body: string; text_body: string };
  }
  const keyring = await contactKeysToOpen(trx);
  const opened = await openContact(keyring, { tenantId, field: PLACE }, row.content_sealed);
  const { toEmail, subject, html, text } = opened;
  if (
    typeof toEmail !== "string" ||
    typeof subject !== "string" ||
    typeof html !== "string" ||
    typeof text !== "string"
  ) {
    throw new Error("a sealed message is missing its content");
  }
  return {
    ...row,
    to_email: toEmail,
    to_name: typeof opened.toName === "string" ? opened.toName : null,
    subject,
    html_body: html,
    text_body: text,
  };
}
