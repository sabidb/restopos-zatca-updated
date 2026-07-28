# RestoPOS landing page — restopos.store

A single self-contained `index.html`. No build step, no dependencies, no
external requests: fonts are system stacks and the receipt QR is drawn on a
canvas, so the page renders identically offline and behind any CSP.

## The one thing to set

`APP_URL` at the top of the `<script>` block in `index.html`. It is where
every **Try Now** button sends people, and it must point at the deployed POS
app (the `restopos-zatca-updated` project).

```js
var APP_URL = "https://app.restopos.store";
```

## Deploying to restopos.store

`restopos.store` currently serves the POS app itself, so putting the landing
page on that domain means giving the app a home of its own first.

1. **Give the app its own hostname.** In the existing Vercel project for
   `restopos-zatca-updated`, add the domain `app.restopos.store` (or keep its
   `*.vercel.app` URL and use that). Confirm the app loads there.
2. **Point `APP_URL` at it** in `index.html`.
3. **Create a second Vercel project** from this repository with
   **Root Directory** set to `landing`, framework preset **Other**, no build
   command. Assign `restopos.store` (and `www`) to it.
4. Leave the app project's domain in place until step 3 is live, so there is
   no window where neither serves.

## Existing installs keep working

Tills that installed RestoPOS as a PWA have a shortcut whose `start_url` is
`/`, which after the switch resolves to this page. The script checks
`display-mode: standalone` on load and, when the page was opened from an
installed shortcut, redirects to `APP_URL` immediately — so an existing client
never gets shown a sales pitch instead of their till.

Tell clients on older installs to reinstall from `app.restopos.store` at their
convenience; the redirect covers them until they do.
