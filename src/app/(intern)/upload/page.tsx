import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getTemplateSettings } from "@/lib/settings";
import { DEFAULT_TEMPLATE_EXAMPLE } from "@/lib/filename-template";
import { Uploader } from "@/components/uploader";

export const metadata: Metadata = { title: "Sammelupload" };

export default async function UploadPage() {
  await requireUser();
  const settings = await getTemplateSettings();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Sammelupload</h1>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-ink-soft">
          Laden Sie beliebig viele Gesprächsaufzeichnungen gleichzeitig hoch. Vor dem Absenden
          werden Dateityp, Pflichtangaben und bereits vorhandene Dateien geprüft. Nicht lesbare
          Dateinamen lassen sich direkt in der Liste manuell erfassen. Nach dem Upload startet die
          deutsche Transkription automatisch.
        </p>
      </div>

      <div className="notice notice-info">
        Aktive Dateinamensvorlage (Version {settings.version}):{" "}
        <code className="font-mono">{settings.template}</code> · Beispiel:{" "}
        <code className="font-mono">{DEFAULT_TEMPLATE_EXAMPLE}</code>
      </div>

      <Uploader template={settings.template} />
    </div>
  );
}
