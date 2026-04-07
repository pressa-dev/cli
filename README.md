# Pressa CLI

Command-line interface for [Pressa](https://pressa.dev) — Compile-as-a-Service. LaTeX in, PDF out.

## Installation

```bash
npm install -g pressa
```

## Quick Start

```bash
# Set your API key
pressa auth

# Compile a LaTeX file
pressa compile report.tex

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
| `-c, --compiler` | LaTeX compiler: `pdflatex` (default), `xelatex`, `lualatex` |
| `-o, --output` | Output PDF filename |
| `--json` | Machine-readable JSON output |
| `--no-download` | Don't download PDF, just return URL |
| `-u, --url` | API base URL override |

Use `-` as filename to read from stdin.

### `pressa usage`

Show your API usage statistics.

```
Plan:    free
Used:    3/10 this month
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
