import type { ApplicationRow } from "../repos/applications.js";

// Small helpers shared by the tools, so every tool replies in the same shape.

export function text(body: string, isError = false) {
  return { content: [{ type: "text" as const, text: body }], ...(isError && { isError }) };
}

export function applicationLine(a: ApplicationRow): string {
  const parts = [`${a.role} at ${a.company}`, a.status];
  if (a.applied_at) parts.push(`applied ${a.applied_at}`);
  if (a.source) parts.push(`via ${a.source}`);
  return `- ${parts.join(" | ")} (id ${a.id})`;
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}