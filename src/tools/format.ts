import type { ApplicationRow, PipelineSummary } from "../repos/applications.js";
import type { EventRow } from "../repos/events.js";

// Small helpers shared by the tools, resources and prompts, so they all reply in the same shape.

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

// get_pipeline_summary and jobhunt://pipeline.
export function pipelineText(s: PipelineSummary): string {
  const rate = s.sent > 0 ? Math.round((s.responded / s.sent) * 100) : 0;
  return [
    `Total tracked: ${s.total} (${s.sent} sent, ${s.total - s.sent} on the wishlist)`,
    `Response rate: ${s.responded}/${s.sent} = ${rate}% got an OA, interview, offer or rejection`,
    "By status:",
    ...s.byStatus.map((r) => `- ${r.status}: ${r.count}`),
    "By source:",
    ...s.bySource.map((r) => `- ${r.source}: ${r.count}`),
  ].join("\n");
}

// get_application and jobhunt://applications/{id}: the application plus its history.
export function applicationDetailText(app: ApplicationRow, events: EventRow[]): string {
  const history = events.map((e) => {
    const what =
      e.kind === "created" ? `created as ${e.to_status}`
      : e.kind === "status_change" ? `${e.from_status} -> ${e.to_status}`
      : e.kind === "updated" ? `edited ${Object.keys((e.details?.after as object) ?? {}).join(", ")}`
      : "deleted";
    return (
      `- ${isoDay(e.occurred_at)}: ${what}` +
      (e.note ? ` (${e.note})` : "") +
      (e.actor ? ` [${e.actor}]` : "")
    );
  });
  return [
    applicationLine(app),
    app.url && `URL: ${app.url}`,
    app.notes && `Notes: ${app.notes}`,
    "History:",
    ...history,
  ]
    .filter(Boolean)
    .join("\n");
}