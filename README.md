# Woodshed

Log hours per habit. One tap to time, +15/+30 to add, daily targets per weekday, done marks, and a Mon–Sun week grid.

Plain HTML/CSS/JS. No build step, no framework, no AI needed.

## Run it on your Mac

```
cd ~/Projects/woodshed
python3 -m http.server 8766
```

Then open http://localhost:8766 in any browser.

## Where the data lives

In the browser's local storage on each device. Nothing leaves the device.
Back it up from the menu (☰) → Your data → Export backup (.json). Import the same file to restore.
Sessions also export as CSV (date, habit, minutes, logged_at).

## Files

- `index.html`: the page
- `style.css`: the look (ECM Air: pale, quiet, Jost font)
- `app.js`: everything else. Storage is in one section at the top, so a sync backend can replace it later.
- `sw.js` + `manifest.webmanifest` + icons: lets it install to a phone home screen and work offline once hosted.

## Data format (backup .json)

```
{ v: 1,
  habits:   [{ id, name, order, retired, targets: [Mon..Sun minutes or null] }],
  sessions: [{ id, habit, date: "YYYY-MM-DD", minutes, at: ISO time }],
  marks:    { "YYYY-MM-DD|habitId": true/false },   // manual done overrides
  timer:    null or { habit, start: ms } }
```
