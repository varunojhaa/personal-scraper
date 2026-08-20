# Plan: Single-line wget command

## Goal
When you paste the wget output into a terminal, it should be **one line** that downloads every selected file, instead of one `wget` per line.

## Change
File: `src/lib/pixeldrain-extract.ts` — `buildWget()`.

Currently each file becomes its own line joined by `\n`:
```
[ -f 'name.done' ] || { wget ... && touch 'name.done'; }
wget ...
```

Switch the joiner from `\n` to `; ` so the entire block is a single copy-pasteable shell command line. Each segment stays self-contained (the `.done` skip-guard and `wget` flags are unchanged), so:
- finished files are still skipped (no Ctrl+C needed),
- partial files still resume with `-c`,
- the optional `&&` between segments is replaced with `;` so a single failure does not stop the rest.

Result example (Pixeldrain):
```
wget --content-disposition -c ... "url1"; wget --content-disposition -c ... "url2"
```

## UI
File: `src/routes/index.tsx`.

- The wget `<Textarea>` currently sizes rows to `wgetItems.length + 2` (multi-line). Change it to a fixed small height (e.g. 3 rows) with `overflow-x-auto` so the one-liner stays readable without stretching the page.
- Update the helper text under it from "Copy this whole block…" to "Copy this command and paste it into a terminal — it downloads every selected file in one line, with resume and correct filenames."
- The `.txt` download still exports the same single-line string.

## Out of scope
- IDM list and `.ef2` export stay as-is (one URL per line, as IDM expects).
- No new toggles; the wget output is always one line.
