# Deployment

This guide takes the working local copy from the [setup guide (04)](04-setup.md) and puts it on the web: a Netlify site that rebuilds itself on every push, reachable from any device, installable to a phone home screen. Netlify's free tier covers a single-learner deployment comfortably.

The deploy itself is mostly clicking through Netlify's importer — the substance of this guide is the small set of ordering rules around it. One of them matters more than all the others: **set the environment variables before the first deploy.** The reason is explained where it comes up.

---

## Step 1 — Push the repository to GitHub

If you used **Use this template** or forked during setup, this is already done and pushes are just `git push`. If you started from a ZIP, create a repository on GitHub now (private is fine — the site builds from it either way), then from the project folder:

```
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOU/YOUR-REPO.git
git push -u origin main
```

Before that first commit, glance at what's being staged: `.env` and any service-account files must not appear (the shipped `.gitignore` excludes `.env`, but a key file saved in the wrong place is on you — the setup guide's rule was to keep it outside the folder entirely).

## Step 2 — Create the Netlify site

At [app.netlify.com](https://app.netlify.com): **Add new site → Import an existing project → GitHub**, authorize, and pick your repository.

On the configuration screen, the build command, publish directory, and functions directory are all supplied by the shipped `netlify.toml` — leave whatever the importer pre-fills, it will be overridden correctly. The one field the toml does **not** control is the **base directory: it must be empty.** This distinction is worth remembering beyond the first deploy — if you ever re-link the site to a different repository, a stale base directory from the previous link survives the relink and produces baffling build failures, because the toml can't reach it.

Don't click Deploy yet.

## Step 3 — Environment variables, before the first deploy

In the site's configuration (Site configuration → Environment variables), add:

| Variable | Value |
|---|---|
| The six `VITE_FIREBASE_*` | Same values as your local `.env` |
| `KRDICT_API_KEY` | If you set it up |
| `ANTHROPIC_API_KEY` | If you set it up |
| The five `GCP_*` | If you set up TTS (same one-line `private_key` rule) |

The demo variables from `.env.example` are not needed — leave them out entirely.

Here is why this comes before deploying: Vite **inlines** every `VITE_*` value into the JavaScript bundle *at build time*. A build that runs before the variables exist produces a bundle with an undefined Firebase config — and it deploys green. The site goes live, loads, and fails at boot with no useful error. If that's already happened to you, the fix is simply: add the variables, then **Deploys → Trigger deploy** to rebuild. The same rule applies forever after — changing a `VITE_*` variable never affects the live site until the next build.

The function-only keys (`KRDICT_API_KEY`, `ANTHROPIC_API_KEY`, `GCP_*`) are read at request time rather than baked into the bundle, and they stay server-side — this is the whole reason the serverless functions exist. Netlify's secrets scanner would normally flag the `VITE_FIREBASE_*` values appearing in the built bundle; the shipped `netlify.toml` already lists them in `SECRETS_SCAN_OMIT_KEYS` because Firebase web config is public by design.

Now deploy (**Deploys → Trigger deploy**, or just push a commit).

## Step 4 — Authorize the domain in Firebase

Google sign-in only works from domains Firebase has been told about, and your new Netlify domain isn't one yet. In the Firebase console: Build → Authentication → **Settings → Authorized domains → Add domain**, and add your site's domain (`your-site.netlify.app`). Until this is done, the sign-in popup on the live site fails — localhost worked during setup only because it's authorized by default.

If you later attach a custom domain, add that here too.

## Step 5 — Verify in production

Open the live site and walk the same smoke test as setup, because production has two things localhost didn't — the built bundle and Netlify's env vars:

1. **Sign in** with Google (proves the config baked into the bundle and the authorized domain).
2. **Add a task and reload** (proves a database read and write through the deployed rules).
3. **Fetch a definition** (proves the functions deployed and can see their env vars — function variables live on Netlify now, not in your `.env`).

If all three pass, the deployment is done.

## Step 6 — Phone and domain

The app ships a PWA manifest and icons, so the live site installs to a phone home screen as-is: open it in the phone's browser and use "Add to Home Screen" (Safari's share menu on iOS, Chrome's menu on Android). It launches full-screen like a native app — handy for dropping a word into the index the moment you meet it, with the fuller workflows waiting on your larger screens, all in sync.

A custom domain is optional and orthogonal: Domain management → Add a domain on Netlify, then remember to add it to Firebase's authorized domains (step 4).

## Ongoing

The rhythm from here:

- **Code changes** deploy themselves: push to `main`, Netlify rebuilds. Each deploy is atomic — the site never serves a half-built state — and the Deploys tab keeps history you can instantly roll back to.
- **Environment variable changes** need a manual **Trigger deploy** afterward — for the `VITE_*` values because of build-time inlining, and it's the safe habit for the function keys too.
- **Rules and indexes** are *not* part of the Netlify pipeline. They deploy from your machine with the Firebase CLI, same as setup: `firebase deploy --only firestore --project YOUR-PROJECT-ID`. If you ever modify `firestore.rules`, read the data model guide's rules section first, deploy, and immediately test sign-in plus one read and one write.

That's the whole operational surface: push code, occasionally trigger a rebuild, occasionally deploy rules. For customizing what you've just deployed — themes, another language, new features — the [theming (09)](09-customizing-themes.md), [language-conversion (08)](08-converting-to-another-language.md), and [building-with-AI (07)](07-building-with-ai.md) guides pick up from here.
