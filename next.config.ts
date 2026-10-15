import path from "node:path";
import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

const nextConfig: NextConfig = {
  // Das Projektverzeichnis ist die Wurzel; ausserhalb liegende Lockfiles
  // sollen die Auflösung nicht beeinflussen.
  turbopack: { root: path.resolve(".") },
};

export default nextConfig;

// Stellt in `next dev` die Bindings aus wrangler.jsonc bereit (lokaler R2-Bucket).
initOpenNextCloudflareForDev();
