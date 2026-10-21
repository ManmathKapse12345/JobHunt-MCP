// Past applications from LinkedIn's data export (Settings -> Data privacy -> Get a copy of
// your data -> Job applications): "Job Applications.csv", sometimes split into
// "Job Applications_1.csv", ... Columns (by header name, in any order):
//   Application Date, Contact Email, Contact Phone Number, Company Name, Job Title,
//   Job Url, Resume Name, Question And Answers
//
// Only company, title, URL and date are kept. Contact details, the résumé name and the
// screening answers are never put in the tracker or printed.
//
// Every row becomes an add_application change for the human to approve (in batches of
// MAX_BATCH_ITEMS, a checkbox each). Rows already tracked are skipped: same company (by
// orgKey, as for email) and the same role.

import { z } from "zod";
import { orgKey, sameOrg } from "../google/classify.js";
import { sameRole } from "../google/match.js";
import { ActionError, MAX_BATCH_ITEMS, prepareAdd, prepareBatch, type Prepared } from "../hitl/actions.js";
import type { ApplicationRow } from "../repos/applications.js";

export interface LinkedInApplication {
  company: string;
  role: string;
  appliedOn: string; // YYYY-MM-DD
  url: string | undefined;
}

export interface ParseResult {
  rows: LinkedInApplication[];
  problems: string[]; // per row, by line number; never the row's content
}

const Url = z.url({ protocol: /^https?$/ });

export function parseLinkedInApplications(csv: string): ParseResult {
  const [header, ...records] = parseCsv(csv);
  if (!header) return { rows: [], problems: ["The file is empty."] };
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const at = { date: col("Application Date"), company: col("Company Name"), title: col("Job Title"), url: col("Job Url") };
  const missing = Object.entries({ "Application Date": at.date, "Company Name": at.company, "Job Title": at.title })
    .filter(([, i]) => i < 0)
    .map(([n]) => n);
  if (missing.length) {
    return { rows: [], problems: [`Not a LinkedIn "Job Applications" file: no ${missing.join(", ")} column.`] };
  }

  const rows: LinkedInApplication[] = [];
  const problems: string[] = [];
  for (const [i, r] of records.entries()) {
    if (r.every((v) => v.trim() === "")) continue;
    const company = r[at.company]?.trim() ?? "";
    const role = r[at.title]?.trim() ?? "";
    const appliedOn = linkedInDate(r[at.date] ?? "");
    const rawUrl = at.url >= 0 ? r[at.url]?.trim() : undefined;
    const row = i + 2; // as a spreadsheet numbers it: the header is row 1
    // Shifted columns would put, say, a phone number in "company": skip rather than guess.
    if (r.length !== header.length) problems.push(`Row ${row}: ${r.length} columns where the header has ${header.length}, skipped.`);
    else if (!company || !role) problems.push(`Row ${row}: no company or job title, skipped.`);
    else if (!appliedOn) problems.push(`Row ${row}: unreadable application date, skipped.`);
    else rows.push({ company, role, appliedOn, url: rawUrl && Url.safeParse(rawUrl).success ? rawUrl : undefined });
  }
  return { rows, problems };
}

// "10/15/24, 9:41 PM" (LinkedIn's format, month first), or an ISO date. The date is as
// LinkedIn wrote it; the time is dropped.
export function linkedInDate(s: string): string | null {
  const t = s.trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/.exec(t);
  const iso = /^(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  const [y, m, d] = us
    ? [us[3]!.length === 2 ? 2000 + Number(us[3]) : Number(us[3]), Number(us[1]), Number(us[2])]
    : iso
      ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
      : [];
  if (!y || !m || !d) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null; // 2/30
  return date.toISOString().slice(0, 10);
}

export interface ImportProposals {
  batches: Prepared[]; // up to MAX_BATCH_ITEMS changes each, oldest applications first
  alreadyTracked: number;
  duplicates: number; // the same job twice in the export (applied again): the first is kept
  skipped: Array<{ what: string; reason: string }>;
}

export async function proposeImport(rows: LinkedInApplication[], tracked: ApplicationRow[]): Promise<ImportProposals> {
  const sorted = [...rows].sort((a, b) => a.appliedOn.localeCompare(b.appliedOn));
  const seen: LinkedInApplication[] = [];
  const adds: Prepared[] = [];
  const skipped: ImportProposals["skipped"] = [];
  let alreadyTracked = 0;
  let duplicates = 0;

  type Job = { company: string; role: string };
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  // Same organisation and the same title: the same job.
  const exact = (a: Job, b: Job) => sameOrg(orgKey(a.company), orgKey(b.company)) && norm(a.role) === norm(b.role);
  // Same organisation, one title inside the other ("SDE" / "SDE Intern"): probably, so ask.
  const close = (a: Job, b: Job) => sameOrg(orgKey(a.company), orgKey(b.company)) && sameRole(a.role, b.role);

  for (const r of sorted) {
    if (seen.some((s) => exact(s, r))) {
      duplicates++;
      continue;
    }
    seen.push(r);
    if (tracked.some((a) => exact(a, r))) {
      alreadyTracked++;
      continue;
    }
    const near = tracked.find((a) => close(a, r));
    if (near) {
      skipped.push({
        what: `${r.role} at ${r.company}`,
        reason: `looks like "${near.role}" at ${near.company}, already tracked; add it yourself if it's a different job`,
      });
      continue;
    }
    try {
      adds.push(await prepareAdd({ company: r.company, role: r.role, status: "applied", appliedOn: r.appliedOn, url: r.url, source: "LinkedIn" }));
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      skipped.push({ what: `${r.role} at ${r.company}`, reason: err.message });
    }
  }

  const batches: Prepared[] = [];
  for (let i = 0; i < adds.length; i += MAX_BATCH_ITEMS) {
    const part = adds.slice(i, i + MAX_BATCH_ITEMS);
    const of = adds.length > MAX_BATCH_ITEMS ? ` (part ${batches.length + 1} of ${Math.ceil(adds.length / MAX_BATCH_ITEMS)})` : "";
    const apps = `${part.length} application${part.length === 1 ? "" : "s"}`;
    batches.push(prepareBatch(`${apps} from your LinkedIn export${of}:`, part));
  }
  return { batches, alreadyTracked, duplicates, skipped };
}

// RFC 4180: commas, quotes ("" inside quotes) and line breaks inside quoted fields, which
// the screening answers have. A UTF-8 BOM is dropped.
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
