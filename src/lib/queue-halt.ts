import { formatDate, formatDateTime, utcToCetParts } from "./time";
import type { QueueHalt } from "./types";

/** „Derzeit pausiert wegen API-Limit (bis 01.12.2026)“ oder „Vom Admin pausiert“. */
export function haltText(halt: QueueHalt): string {
  if (!halt) return "";
  if (halt.kind === "pausiert") return "Vom Admin pausiert";
  const { hour, minute } = utcToCetParts(halt.until);
  const until = hour === 0 && minute === 0 ? formatDate(halt.until) : formatDateTime(halt.until);
  return `Derzeit pausiert wegen API-Limit (bis ${until})`;
}
