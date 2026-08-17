import "server-only";
import { Collections, findById, updateOne, insertUnique } from "./db";
import { DEFAULT_TEMPLATE } from "./filename-template";
import type { FilenameTemplateSettings } from "./types";

const TEMPLATE_ID = "filename_template";

export async function getTemplateSettings(): Promise<FilenameTemplateSettings> {
  const existing = await findById<FilenameTemplateSettings>(Collections.settings, TEMPLATE_ID);
  if (existing) return { ...existing, _id: TEMPLATE_ID, history: existing.history ?? [] };
  const fallback: FilenameTemplateSettings = {
    _id: TEMPLATE_ID,
    template: DEFAULT_TEMPLATE,
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: "system",
    history: [],
  };
  await insertUnique(Collections.settings, { ...fallback });
  const created = await findById<FilenameTemplateSettings>(Collections.settings, TEMPLATE_ID);
  return created ? { ...created, history: created.history ?? [] } : fallback;
}

/**
 * Speichert eine neue Vorlage mit erhöhter Versionsnummer. Bestehende
 * Aufnahmen behalten ihre Versionsangabe und werden nicht neu interpretiert.
 */
export async function saveTemplate(
  template: string,
  updatedBy: string,
): Promise<FilenameTemplateSettings> {
  const current = await getTemplateSettings();
  if (current.template === template) return current;
  const next: FilenameTemplateSettings = {
    _id: TEMPLATE_ID,
    template,
    version: current.version + 1,
    updatedAt: new Date().toISOString(),
    updatedBy,
    history: [
      ...current.history,
      {
        version: current.version,
        template: current.template,
        updatedAt: current.updatedAt,
        updatedBy: current.updatedBy,
      },
    ].slice(-20),
  };
  await updateOne(Collections.settings, { _id: TEMPLATE_ID }, { $set: next });
  return next;
}
