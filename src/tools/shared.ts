import { readFileSync } from "node:fs";

export function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;
