"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { renameUser } from "@/lib/profile";
import type { ProfileState } from "@/lib/profile-state";

/**
 * Ändert den eigenen Anzeigenamen. Jede Person bearbeitet ausschliesslich das
 * eigene Konto – die Adresse stammt aus der Sitzung, nicht aus dem Formular.
 */
export async function updateNameAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "");

  const result = await renameUser(user.email, name);
  if (!result.ok) return { status: "fehler", message: result.error, name };

  if (!result.changed) {
    return { status: "erfolg", message: "Der Name ist unverändert geblieben.", name: result.name };
  }

  revalidatePath("/einstellungen");
  revalidatePath("/aufnahmen");
  revalidatePath("/aufnahmen/[id]", "page");
  revalidatePath("/admin");

  return {
    status: "erfolg",
    message:
      result.updatedEntries > 0
        ? `Name gespeichert. ${result.updatedEntries} bereits vorhandene Einträge wurden angepasst.`
        : "Name gespeichert.",
    name: result.name,
  };
}
