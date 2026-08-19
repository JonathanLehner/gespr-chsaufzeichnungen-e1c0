/**
 * Hypher liefert keine eigenen Typen mit. Gebraucht wird nur die Silbentrennung
 * eines einzelnen Wortes; die übrigen Methoden bleiben hier bewusst ungenannt.
 */
declare module "hypher" {
  export type HyphenationPatterns = {
    id: string;
    leftmin: number;
    rightmin: number;
    patterns: Record<number, string>;
    exceptions?: string;
  };

  export default class Hypher {
    constructor(language: HyphenationPatterns);
    hyphenate(word: string): string[];
    hyphenateText(text: string, minLength?: number): string;
  }
}

declare module "hyphenation.de" {
  import type { HyphenationPatterns } from "hypher";
  const patterns: HyphenationPatterns;
  export default patterns;
}
