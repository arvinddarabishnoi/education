# JEE Daily

A browser-based JEE Main Paper 1 practice platform with automated daily paper generation.

## Structure

- `index.html` — exam UI
- `data/papers/index.json` — paper archive index
- `data/papers/YYYY-MM-DD.json` — generated papers
- `config/jee-main.json` — exam pattern/configuration
- `scripts/generate-paper.mjs` — generation + validation pipeline
- `.github/workflows/daily-paper.yml` — daily automation

## Daily automation

The GitHub Action runs every day at 00:30 UTC (06:00 IST), and can also be run manually.

Before the first run, add this repository secret:

`OPENAI_API_KEY`

GitHub:
Settings → Secrets and variables → Actions → New repository secret.

The workflow:
1. Generates a new 75-question paper.
2. Runs deterministic structural/duplication checks.
3. Runs an independent AI quality-control pass.
4. Repairs QC failures once.
5. Re-validates the repaired questions.
6. Writes the dated JSON file.
7. Updates the paper index.
8. Commits and pushes only after validation succeeds.

The workflow never publishes the new paper when validation fails.

## GitHub Pages

Settings → Pages → Deploy from branch → `main` → `/ (root)`.

Then open the Pages URL shown by GitHub.

## Important

This is a practice platform, not an official NTA application. The configured exam pattern should be checked against the latest official NTA bulletin before making claims about official exam equivalence.
