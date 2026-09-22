# Pressa CLI

Command-line interface for [Pressa](https://pressa.dev) - LaTeX in, publication-quality PDF out.

**No API key required to start.** No install required either:

```bash
npx @pressa/cli compile report.tex
```

That works as printed. Anonymous callers get 3 successful compilations per day;
failed attempts do not count, so you can iterate on your LaTeX for free.

## Installation

```bash
npm install -g @pressa/cli
```

## Quick Start

```bash
# Compile a LaTeX file - no key needed
pressa compile report.tex

# Optional: add a key for 50 compilations/month, images and templates
pressa auth

# Compile with a specific engine
pressa compile report.tex --compiler xelatex

# Read from stdin
cat report.tex | pressa compile -

# JSON output (for AI agents)
pressa compile report.tex --json
```

## Commands

### `pressa auth`

Configure your API key.

```bash
# Interactive
pressa auth

# Non-interactive
pressa auth --key pressa_xxxx
```

### `pressa compile <file>`

Compile a LaTeX file to PDF.

| Option | Description |
|--------|-------------|
| `-c, --compiler` | LaTeX compiler: `pdflatex` (default), `xelatex`, or `lualatex` (Pro and Business plans only) |
| `-o, --output` | Output PDF filename |
| `--json` | Machine-readable JSON output |
| `--no-download` | Don't download PDF, just return URL |
| `-a, --asset` | Include a local asset file (repeatable). `logo.png` or `logo.png=/path/to/file.png` |
| `-s, --stored-asset` | Reference a stored asset by name from the library (repeatable) |
| `-u, --url` | API base URL override |

Use `-` as filename to read from stdin.

The file must be LaTeX source code (containing `\documentclass`, `\begin{document}`, `\input{}`, or `\include{}`). Pressa is a LaTeX compiler, not a text-to-PDF converter. The CLI prints a yellow warning if the file does not look like LaTeX, and the server rejects non-LaTeX input with `not_latex_source` even if the warning is ignored. To produce a PDF from plain text or markdown, ask an AI agent to generate LaTeX from your content first.

Each plan has limits on pages per document, LaTeX source size, PDF output size, and compile timeout. If a compile exceeds your plan's page limit, the document does not count against your monthly quota and the CLI prints the limit and an upgrade URL.

### `pressa templates` (Saved Templates)

Manage saved LaTeX templates and their accompanying agent instructions. Requires a paid plan (Starter or above).

```bash
# List saved templates. The [instructions] badge appears next to templates
# that carry an instructions playbook for the AI agent.
pressa templates list

# Save a template (upserts by name)
pressa templates save "Monthly Invoice" invoice.tex \
  --description "Toptal freelance invoice"

# Save a template with agent instructions (a prose markdown playbook
# describing how the template should be filled in: defaults, workflow,
# edge cases, conditional logic). Up to 50000 characters.
pressa templates save "Monthly Invoice" invoice.tex \
  --description "Toptal freelance invoice" \
  --instructions-file invoice-rules.md

# Or pass instructions inline (for short rules)
pressa templates save "Cover Letter" cover.tex \
  --instructions "Ask user for company and role only; today's date; sign as account owner."

# Fetch a template. By default prints the LaTeX content; pass --output to
# write it to a file. Pass --instructions-out to write the instructions
# (if any) to a separate file in parallel.
pressa templates get "Monthly Invoice" \
  --output invoice.tex \
  --instructions-out invoice-rules.md

# Delete a template (asks for confirmation unless --yes)
pressa templates delete "Monthly Invoice" --yes
```

| Option | Applies to | Description |
|--------|------------|-------------|
| `-d, --description <text>` | save | Short human-readable summary (max 500 chars) |
| `--instructions <text>` | save | Inline agent playbook (prose markdown, max 50000 chars) |
| `--instructions-file <path>` | save | Read agent playbook from a file (mutually exclusive with `--instructions`) |
| `-o, --output <path>` | get | Write LaTeX content to file instead of stdout |
| `--instructions-out <path>` | get | Write instructions (if present) to a separate file |
| `--json` | list, get | Raw JSON output |
| `-y, --yes` | delete | Skip confirmation |

`description` is a one-line summary shown in `templates list`. `instructions` is the longer playbook your AI agent reads alongside the LaTeX when filling the template - they are different fields. The list output prints a `[instructions]` badge for templates that have an instructions playbook attached.

### `pressa assets` (Asset Library)

Manage a persistent library of assets (logos, signatures, images) that can be referenced by name across compiles. Requires a paid plan (Starter or above).

```bash
# List stored assets and quota
pressa assets list

# Upload a file (uses the basename by default)
pressa assets upload ./logo.png

# Upload under a different name
pressa assets upload ./brand-logo.png --name logo.png

# Download an asset back to disk
pressa assets get logo.png --output ./logo.png

# Print metadata as JSON (no binary content)
pressa assets get logo.png --json

# Delete (asks for confirmation unless --yes)
pressa assets delete logo.png --yes
```

Use stored assets in a compile by name (skips re-uploading large files on every request):

```bash
pressa compile invoice.tex --stored-asset logo.png --stored-asset signature.png
```

`--stored-asset` is repeatable and can be combined with inline `--asset` flags. A name cannot appear in both at the same time.

### `pressa usage`

Show your API usage statistics.

```
Plan:    free
Used:    3/50 this month
Resets:  April 30, 2026
API Key: pressa_c... (Test Key)
```

## Configuration

Config is stored in `~/.pressa/config.json`:

```json
{
  "api_key": "pressa_xxxx",
  "api_url": "https://api.pressa.dev"
}
```

## Development

```bash
cd cli
npm install
npm run build
npm run dev    # watch mode
```

## License

MIT
