import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Das Projektverzeichnis ist die Wurzel; ausserhalb liegende Lockfiles
  // sollen die Auflösung nicht beeinflussen.
  turbopack: { root: path.resolve(".") },
};

export default nextConfig;
