import z from "zod";

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid format. Must be YYYY-MM-DD")
  .refine(
    (val) => {
      const d = new Date(val);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === val;
    },
    { message: "Not a real calendar date (e.g. 2026-02-30)" },
  );

// Today's date in the machine's local timezone, as YYYY-MM-DD.
// Don't use toISOString() here: it returns the UTC date, which in India
// is still yesterday between 00:00 and 05:30 local time.
export function todayIso(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
