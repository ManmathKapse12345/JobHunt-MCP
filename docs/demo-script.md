# Demo recording script (60–90 s)

The story: **ask → the AI proposes a change → a human approves → the database updates**, then one beat that shows the safety rail. Everything runs locally on the demo data, so your real tracker never appears on screen.

## Before you record (5 minutes)

1. `npm run build`, then `npm run demo:db` (loads the 9 sample applications; run it again to reset between takes).
2. Point Claude Desktop at the demo database: use the config from the README's "Connect in 2 minutes", then fully quit and reopen Claude Desktop. Check the tools icon shows `jobhunt`.
3. Open a terminal next to Claude Desktop, sized so both fit on screen, and type `npm run demo:show` without pressing Enter yet. Use a large font (about 16 pt) so it is readable in a small GIF.
4. Start a **new chat**. Turn off notifications (Windows: Focus / Do not disturb), close other windows, and hide anything personal (email, bookmarks bar).
5. Recorder: **ScreenToGif** (free; records a region straight to GIF) or **Win + Alt + R** (Xbox Game Bar; records the active window as MP4). Record a 1280×720 region if you can.

## Shot list

| Time | On screen | You do / type |
|---|---|---|
| 0–5 s | Claude Desktop, new chat, `jobhunt` visible in the tools menu | Nothing: let the viewer read the title |
| 5–20 s | Read tool | Type **How is my job search going?** → Claude calls `get_pipeline_summary` and answers (9 tracked, response rate). Expand the tool call once so the viewer sees it is a real call |
| 20–30 s | The proposal | Type **Stripe just made me an offer!** → Claude calls `update_application_status` |
| 30–45 s | **The approval** | *If an in-chat form appears:* pause 2 s on the summary ("Stripe · Backend Engineer: interview → offer"), tick **Approve this change**, submit.<br>*If Claude shows a link instead:* click it, pause on the approval page, click **Approve**, switch back to Claude Desktop |
| 45–55 s | **The database updates** | Switch to the terminal, press Enter on `npm run demo:show`: Stripe is now the top row with status `offer` |
| 55–75 s | The safety rail | Back in Claude, type **Delete all my rejected applications** → Claude lists them / asks, and each delete waits for approval. **Decline** (or close the link). Run `npm run demo:show` again: Flipkart and Zomato are still there |
| 75–85 s | End card | Show the README top (badges and the 50/50 eval line) or the GitHub repo page |

Tips:
- Type at a normal speed, or paste each prompt. Cut out the wait while the model thinks (ScreenToGif's editor lets you delete frames; with an MP4, trim in Clipchamp, which comes with Windows).
- Don't narrate with captions on every step: two or three short overlays are enough, e.g. "Nothing changes until a human approves", "Declined → nothing changed".
- If a take goes wrong, `npm run demo:db` resets the data and you start a new chat.

## Export and add it to the README

**GIF (shows inline everywhere):**
- ScreenToGif → Save as GIF, 10–12 fps, width 960–1280 px. Keep it under ~10 MB so the README loads fast.
- From an MP4, with ffmpeg:
  ```bash
  ffmpeg -i demo.mp4 -vf "fps=12,scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" docs/demo.gif
  ```
- Save it as `docs/demo.gif`, then in README.md replace the `<!-- DEMO: ... -->` comment with:
  ```markdown
  ![Demo: ask, approve, the database updates](docs/demo.gif)
  ```

**MP4 (sharper, with controls):** edit README.md on github.com and drag the MP4 into the editor. GitHub uploads it and inserts a link that plays inline. You can do both: GIF at the top, MP4 linked under it ("full-quality video").

Also upload the MP4 to LinkedIn or YouTube (unlisted) for your resume and posts.
