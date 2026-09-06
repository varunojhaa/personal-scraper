# Fix FileDitch downloads blocked by the "Just a moment" check

## What's actually happening

I tested a FileDitch file address directly from a plain script. The reply was not the
site's own verification puzzle — it was a Cloudflare "Just a moment..." interstitial
(HTTP 403, a 5.7 KB page with a Turnstile widget and no form fields to fill in).

That is why the generated command crashes with `HTTP Error 403: Forbidden`: the little
Python helper baked into the command solves FileDitch's own puzzle, but it can never
pass a Cloudflare browser check, because that check requires a real browser.

## The fix

**1. Detect the block and say so plainly**

The helper currently dies with a raw Python traceback. It will instead catch the 403,
recognise the Cloudflare page, and print one clear line explaining the file is behind a
browser check, with the next step to take (below) — no traceback.

**2. Add a "browser session" field for FileDitch**

Add a small optional box in the app: paste your browser's FileDitch clearance cookie
(and it reuses the matching browser identity). When that value is present, every
FileDitch command carries it, so the download goes straight through — this is the same
pass your own browser already holds after you have visited the site once.

Short instructions sit next to the box: open the file page once in your browser, copy
the `cf_clearance` cookie value from the site's cookies, paste it in. The value is kept
in your browser only, not stored anywhere.

**3. Graceful behaviour when it is missing or stale**

If the pasted pass is missing or expired, the command stops with a readable message
telling you to refresh it, instead of silently saving a 14 KB error page.

Pixeldrain links are unaffected and keep working exactly as now.

## Technical notes

- `fileDitchCommand` in `src/lib/pixeldrain-extract.ts`: wrap `request()` in a
  `urllib.error.HTTPError` handler, read the error body, and if it matches the
  Cloudflare interstitial (`Just a moment` / `cf-chl`), exit with a friendly message.
- Thread an optional `clearance` string (cookie value + UA) through `buildWget`,
  `buildShellScript` and `fileDitchCommand`; send it as a `Cookie: cf_clearance=...`
  header on the page request and as `--header` on the final `wget` call.
- UI state for the cookie lives in `src/routes/index.tsx` next to the existing FileDitch
  handling; no server changes, no storage.

## Not included: FitGirl mirror resolution

The second request — following FuckingFast / FileKeeper / DataNodes links from FitGirl
to pull out the direct file addresses — I'm not going to build. Those pages exist to
distribute cracked commercial games, and turning them into a bulk download command is
piracy tooling. Everything else here keeps working, and I'm glad to extend the app for
your own uploads, public-domain archives, or any host you're licensed to fetch from.
