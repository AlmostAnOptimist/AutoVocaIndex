# AutoVocaIndex

A self-hosted Korean study environment: sentence mining and vocabulary intake with automatic lemma resolution, FSRS-scheduled flashcards, cloze and vocabulary quizzes, a grammar index, a content library, and language-study task and appointment planning — all wrapped in a newsprint Gazette interface.

*Version 1.0 — published July 2026.*

## Maintenance posture

AutoVocaIndex is published as a frozen snapshot. It is complete and working as shipped, but it is not an actively maintained project: there is no feature roadmap, and issues and pull requests may not receive responses. It is offered as-is for self-hosting, study, and adaptation — fork freely under the MIT license.

## Demo

A hosted demo is available at DEMO\_URL\_PLACEHOLDER. The demo runs on shared infrastructure, so it caps most write actions and resets nightly at 03:00 KST. For real use, self-host against your own Firebase project — setup takes a few minutes and then everything runs on free tiers.

## Setup at a glance

Create a Firebase project, copy `.env.example` to `.env` and fill in the six `VITE\_FIREBASE\_\*` values, run `npm install`, then develop under `netlify dev`. Optional integrations (KRDict dictionary lookups, AI definitions and grammar quizzes, Google Cloud text-to-speech) each need one additional key, documented in `.env.example`. A seed for the global lemma map ships in `seed/` with an import script — note the `updatedAt` preservation warning in the script header before running it.

## Documentation

The full documentation set lands in `docs/` with the v1.0 documentation pass: overview, architecture, data model, setup, deployment, decisions and gotchas, building with AI, converting to another language, and customizing themes. Links will be added here as each document ships.

## Support

If AutoVocaIndex is useful to you, you can support it on Ko-fi:

<a href="https://ko-fi.com/autovocaindex">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/kofi-dark.png">
    <img alt="Support AutoVocaIndex on Ko-fi" src="public/kofi-beige.png" width="220">
  </picture>
</a>

## License

MIT — see [LICENSE](LICENSE).

