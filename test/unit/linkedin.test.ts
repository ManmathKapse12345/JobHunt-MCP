// Reading LinkedIn's "Job Applications.csv": its quirks, and what is never kept.
import { describe, expect, it } from "vitest";
import { linkedInDate, parseCsv, parseLinkedInApplications } from "../../src/imports/linkedin.js";

// Shaped like a real export (made-up people and jobs). The screening answers span lines
// and contain commas and quotes.
const EXPORT = [
  "﻿Application Date,Contact Email,Contact Phone Number,Company Name,Job Title,Job Url,Resume Name,Question And Answers",
  '"10/15/26, 9:41 PM",me@example.com,+91 98765 43210,Stripe,Backend Engineer,https://www.linkedin.com/jobs/view/111,Resume_2026.pdf,"Years of Java?:3 | Why us?:I like ""payments"",\nand APIs"',
  '"9/2/26, 10:05 AM",me@example.com,+91 98765 43210,"Acme Robotics, Inc.",SDE Intern,https://www.linkedin.com/jobs/view/222,Resume_2026.pdf,',
  ",me@example.com,,Globex,Data Analyst,,Resume_2026.pdf,",
  '"13/45/26, 1:00 PM",me@example.com,,Initech,QA,,Resume.pdf,',
  '"10/1/26, 8:00 AM",me@example.com,,Hooli,,not-a-url,Resume.pdf,',
  // Unquoted date: its comma shifts every column after it.
  "10/3/26, 8:00 AM,me@example.com,+91 98765 43210,Wayne,SRE,,Resume.pdf,",
  "",
].join("\r\n");

describe("parseCsv", () => {
  it("handles quotes, doubled quotes, commas and line breaks inside fields, CRLF and a BOM", () => {
    const rows = parseCsv('a,b\r\n"x, y","he said ""hi""\nthen left"\r\n');
    expect(rows).toEqual([["a", "b"], ["x, y", 'he said "hi"\nthen left']]);
    expect(parseCsv("﻿h1,h2\n1,2")).toEqual([["h1", "h2"], ["1", "2"]]);
  });
});

describe("linkedInDate", () => {
  it.each([
    ["10/15/26, 9:41 PM", "2026-10-15"],
    ["9/2/26, 10:05 AM", "2026-09-02"], // month first
    ["1/31/2026", "2026-01-31"],
    ["2026-03-04", "2026-03-04"],
    ["2/30/26, 1:00 PM", null],
    ["13/45/26", null],
    ["", null],
  ])("%s -> %s", (s, want) => expect(linkedInDate(s)).toBe(want));
});

describe("parseLinkedInApplications", () => {
  it("keeps company, title, URL and date; reports bad rows by number only", () => {
    const { rows, problems } = parseLinkedInApplications(EXPORT);
    expect(rows).toEqual([
      { company: "Stripe", role: "Backend Engineer", appliedOn: "2026-10-15", url: "https://www.linkedin.com/jobs/view/111" },
      { company: "Acme Robotics, Inc.", role: "SDE Intern", appliedOn: "2026-09-02", url: "https://www.linkedin.com/jobs/view/222" },
    ]);
    expect(problems).toEqual([
      "Row 4: unreadable application date, skipped.",
      "Row 5: unreadable application date, skipped.",
      "Row 6: no company or job title, skipped.",
      "Row 7: 9 columns where the header has 8, skipped.",
    ]);
  });

  it("never keeps contact details, the résumé or screening answers", () => {
    const out = JSON.stringify(parseLinkedInApplications(EXPORT));
    for (const secret of ["me@example.com", "98765", "Resume_2026", "Years of Java", "payments"]) {
      expect(out).not.toContain(secret);
    }
  });

  it("a URL that isn't http(s) is dropped, not stored", () => {
    const csv = "Application Date,Company Name,Job Title,Job Url\n1/2/26,Hooli,SRE,javascript:alert(1)\n";
    expect(parseLinkedInApplications(csv).rows[0]!.url).toBeUndefined();
  });

  it("columns are found by name, in any order", () => {
    const csv = "Job Title,Company Name,Application Date\nSRE,Hooli,1/2/26\n";
    expect(parseLinkedInApplications(csv).rows).toEqual([{ company: "Hooli", role: "SRE", appliedOn: "2026-01-02", url: undefined }]);
  });

  it("another kind of file is refused with the reason", () => {
    expect(parseLinkedInApplications("Saved Date,Job Url,Job Title\n").problems).toEqual([
      'Not a LinkedIn "Job Applications" file: no Application Date, Company Name column.',
    ]);
  });
});
