// Erzeugt die statischen Bilder der Startseite einmalig zur Bauzeit.
// Die zurückgegebenen URLs sind dauerhaft und werden im Quelltext festgehalten.
import { readFileSync } from "node:fs";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const KEY = /CLAWCORP_API_KEY=(.+)/.exec(env)[1].trim();

const prompts = [
  {
    name: "hero",
    prompt:
      "Photograph of a bright modern Swiss real estate office in Zurich, a professional sales advisor in a shirt sitting at a desk wearing a discreet headset during a phone call, laptop and printed floor plans on the desk, large windows with soft daylight, calm neutral interior in grey and warm oak, shallow depth of field, documentary business photography, 16:9",
  },
  {
    name: "portal",
    prompt:
      "Photograph of a quiet contemporary meeting room in a Swiss real estate agency, glass wall, oak table with a notebook and a smartphone, city rooftops visible through the window in soft morning light, muted grey and petrol blue tones, no people, architectural interior photography, 4:3",
  },
];

for (const item of prompts) {
  const res = await fetch("https://www.clawcorp.ai/api/platform/gemini", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: item.prompt, model: "gemini-3.1-flash-image" }),
  });
  const data = await res.json();
  console.log(item.name, res.status, data.images?.[0]?.url ?? JSON.stringify(data).slice(0, 200));
}
