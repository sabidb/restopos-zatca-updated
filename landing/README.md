# RestoPOS landing page — restopos.store

A single self-contained `index.html`. No build step, no dependencies, no
external requests: fonts are system stacks and the receipt QR is drawn on a
canvas, so the page renders identically offline and behind any CSP.

## The layout

You own one domain, `restopos.store`. **Subdomains of it are free** — they are
DNS records on a domain you already pay for, not separate purchases. So:

| Address | Serves | Vercel project |
|---|---|---|
| `restopos.store` (and `www`) | **this landing page** | the landing project (`resto-pos-landing`) |
| `app.restopos.store` | **the POS app** | `restopos-zatca-updated` |

Someone searching "restopos.store" lands here. **Try Now** — in the sticky
header, the hero and the closing block — sends them to `app.restopos.store`,
which is the app, where they start the free 14-day trial.

## Setting it up

Do these in order, so there is never a window where nothing serves.

1. **Give the app its subdomain.** Vercel → the `restopos-zatca-updated`
   project → Settings → Domains → add `app.restopos.store`. Vercel shows a CNAME
   record; add it at your registrar. Wait until `https://app.restopos.store`
   loads the POS, then confirm it works.
2. **Check `APP_URL`.** It is already `https://app.restopos.store` — the
   constant at the top of the `<script>` block in `index.html`. Only change it
   if you gave the app a different address.
3. **Point the domain at this page.** Vercel → the landing project → Settings →
   Domains → add `restopos.store` and `www.restopos.store`. If they are
   currently attached to the app's project, remove them there first — a domain
   can only belong to one project.

Deploying this folder as its own Vercel project: **Root Directory** `landing`,
framework preset **Other**, no build command, no install command.

## Existing installs keep working

Tills that installed RestoPOS as a PWA have a shortcut whose `start_url` is
`/`, which after the switch resolves to this page. The script checks
`display-mode: standalone` on load and, when the page was opened from an
installed shortcut, redirects to `APP_URL` immediately — so an existing client
never gets shown a sales pitch instead of their till.

Tell clients on older installs to reinstall from `app.restopos.store` at their
convenience; the redirect covers them until they do.
