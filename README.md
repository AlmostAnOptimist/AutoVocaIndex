# AutoVocaIndex

A self-hosted Korean study environment: sentence mining and vocabulary intake with automatic lemma resolution, FSRS-scheduled flashcards, cloze and vocabulary quizzes, a grammar index, a content library, and language-study task and appointment planning — all wrapped in a newsprint Gazette interface. Built for Korean, and [convertible to another language](docs/08-converting-to-another-language.md).

*Version 1.0 — published July 2026.*

## Maintenance posture

AutoVocaIndex is published as a frozen snapshot. It is complete and working as shipped, but it is not an actively maintained project: there is no feature roadmap, and issues and pull requests may not receive responses. It is offered as-is for self-hosting, study, and adaptation — fork freely under the MIT license.

## Demo

A hosted demo is available at **[autovocaindex.netlify.app](https://autovocaindex.netlify.app)**. The demo runs on shared infrastructure, so it caps most write actions and resets nightly at 03:00 KST. For real use, self-host against your own Firebase project — setup takes a few minutes and then everything runs on free tiers.

## Setup at a glance

Create a Firebase project, copy `.env.example` to `.env` and fill in the six `VITE_FIREBASE_*` values, deploy the shipped Firestore rules with the Firebase CLI, run `npm install`, then develop under `netlify dev`. Optional integrations (KRDict dictionary lookups, AI definitions and grammar quizzes, Google Cloud text-to-speech) each need one additional key, documented in `.env.example`. A seed for the global lemma map ships in `seed/` with an import script — note the `updatedAt` preservation warning in the script header before running it.

The full walkthrough is the [setup guide](docs/04-setup.md), and the [deployment guide](docs/05-deployment.md) takes the result to a live site.

## Documentation

The full documentation set lives in [`docs/`](docs/):

| | |
|---|---|
| [01 — Overview](docs/01-overview.md) | What AVI is, the word process, and what it costs |
| [02 — Architecture](docs/02-architecture.md) | The stack, module layers, data flow, and serverless functions |
| [03 — Data model](docs/03-data-model.md) | Every Firestore collection: shapes, writers, readers, rules |
| [04 — Setup](docs/04-setup.md) | Zero to a working copy on your machine |
| [05 — Deployment](docs/05-deployment.md) | The working copy on the web, synced across your devices |
| [06 — Decisions and gotchas](docs/06-decisions-and-gotchas.md) | The traps and settled tradeoffs — read before modifying |
| [07 — Building with AI](docs/07-building-with-ai.md) | The working protocol for modifying AVI with an AI assistant |
| [08 — Converting to another language](docs/08-converting-to-another-language.md) | Every Korean coupling site and its replacement contract |
| [09 — Customizing themes](docs/09-customizing-themes.md) | The design system: themes, typography, frames, plates |

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
