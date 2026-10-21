# Demo recording script (about 90 s)

The story: **"check my email" → Claude reports what changed → one approval panel in the chat → tick, apply → the tracker updates.** Then one beat that shows the safety rail.

Everything runs on the **demo database** with the **demo inbox**: made-up job emails and a made-up tracker, so no real email address, company or application appears on screen, and no Google account or Gemini key is used.

## Before you record (10 minutes)

1. `npm run build`, then `npm run demo:db`. It loads 9 sample applications and a pretend Gmail account (run it again to reset between takes).
2. Add a demo entry to Claude Desktop's config (**Settings → Developer → Edit Config**), next to your normal `jobhunt` one. Use the absolute path to your clone, with forward slashes:
   ```json
   "jobhunt-demo": {
     "command": "node",
     "args": ["C:/path/to/JobHunt-MCP/dist/index.js"],
     "env": {
       "DATABASE_URL": "postgresql://postgres@localhost:54329/jobhunt_test",
       "DATABASE_URL_READER": "postgresql://mcp_reader@localhost:54329/jobhunt_test",
       "JOBHUNT_DEMO_INBOX": "1"
     }
   }
   ```
   `JOBHUNT_DEMO_INBOX` swaps Gmail for the demo inbox and keeps calendar events in memory. It refuses to run against anything but the local database, so it can't touch your real tracker.
3. Fully quit Claude Desktop (tray icon → Quit) and reopen it. In a new chat's tools menu, switch **jobhunt off** and **jobhunt-demo on**, so Claude only sees the demo.
4. Open a terminal next to Claude Desktop, sized so both fit, and type `npm run demo:show` without pressing Enter. Use a large font (about 16 pt) so it reads in a small GIF.
5. Turn on Do not disturb, close other windows, hide anything personal (bookmarks bar, other chats in the sidebar).
6. Recorder: **ScreenToGif** (free, records a region straight to GIF) or **Win + Alt + R** (Xbox Game Bar, MP4). Record a 1280×720 region if you can.

What the demo inbox contains (dates are relative to the day you record):

| Company | In the demo tracker | The emails say | Proposed |
|---|---|---|---|
| Razorpay | applied | interview invite, the day after tomorrow at 3:00 PM IST | applied → interview, plus a calendar event |
| Postman | applied | "We regret to inform you" | applied → rejected |
| Linear | not tracked | "Thank you for applying" (Frontend Engineer) | add the application |
| Microsoft | oa | assessment due in 3 days | a deadline on the calendar |
| Google | applied | confirmed 5 weeks ago, nothing since | nothing: shown as *ghosted* |
| (alerts) | | "10 new jobs for you", "Google is hiring \| Confirm your application" | ignored |

## Shot list

| Time | On screen | You do / type |
|---|---|---|
| 0–5 s | Claude Desktop, new chat, `jobhunt-demo` on in the tools menu | Nothing: let the viewer read the title |
| 5–25 s | **The report** | Type **Check my email for job updates.** → Claude calls `sync_job_emails` and summarises: Razorpay wants an interview, Postman said no, a new Linear application, a Microsoft deadline, Google has gone quiet. Expand the tool call once so the viewer sees it's a real call |
| 25–35 s | The proposal | Type **Apply those updates.** → Claude calls `propose_email_updates` |
| 35–55 s | **The approval panel** | The panel appears under the reply: 5 changes, each ticked. Pause 2 s on it. **Untick** the Microsoft deadline (shows you choose), click **Apply ticked changes**. The panel shows "Applied 4 of 5 changes; 1 not ticked" |
| 55–65 s | **The tracker updates** | Switch to the terminal, press Enter on `npm run demo:show`: Razorpay is `interview`, Postman `rejected`, Linear is a new row |
| 65–80 s | The safety rail | Back in Claude, type **Delete all my rejected applications.** → Claude lists them and asks first; each delete still needs your approval. Click **Reject**. Run `npm run demo:show` again: nothing was deleted |
| 80–90 s | End card | The README top on GitHub, or the repo page |

Tips:
- Paste each prompt rather than typing. Cut the waits while the model thinks (ScreenToGif's editor deletes frames; for an MP4, trim in Clipchamp, which comes with Windows).
- Two or three short captions are enough, e.g. "Nothing changes until you approve" on the panel, and "Declined → nothing changed" at the end.
- If a take goes wrong: `npm run demo:db`, fully quit and reopen Claude Desktop (it keeps demo calendar events in memory), new chat.
- Afterwards switch **jobhunt** back on and **jobhunt-demo** off (or remove the entry).

## Export and add it to the README

**GIF (shows inline everywhere):**
- ScreenToGif → Save as GIF, 10–12 fps, width 960–1280 px. Keep it under ~10 MB so the README loads fast.
- From an MP4, with ffmpeg:
  ```bash
  ffmpeg -i demo.mp4 -vf "fps=12,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" docs/demo.gif
  ```
- Save it as `docs/demo.gif`, then in README.md replace the `<!-- DEMO: ... -->` comment with:
  ```markdown
  ![Demo: check email, approve in the chat, the tracker updates](docs/demo.gif)
  ```

**MP4 (sharper, with controls):** edit README.md on github.com and drag the MP4 into the editor. GitHub uploads it and inserts a link that plays inline. You can do both: the GIF at the top, the MP4 linked under it ("full-quality video").
