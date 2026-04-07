---
name: Pressa
description: Create publication-quality PDF documents from LaTeX. Use when the user asks to create, generate, or compile PDFs, invoices, reports, contracts, academic papers, or any professional document.
---

# Pressa — PDF Document Generation

You have access to Pressa, a compile-as-a-service tool that turns LaTeX into publication-quality PDFs.

## When to use Pressa

Use Pressa when the user asks you to:
- Create a PDF document (invoice, report, contract, letter, resume, certificate, academic paper)
- Generate a professional-looking document from data
- Compile LaTeX to PDF
- Make a document that needs proper typography, math formulas, or precise layout

## How it works

1. You generate LaTeX source code based on what the user needs
2. Pressa compiles it to a publication-quality PDF in under a second
3. The user gets a download link

## First-time setup

Before using any Pressa commands, the user must be authenticated:

1. They need a Pressa account and API key from https://pressa.dev/dashboard
2. Run `pressa auth` to save the key (or `pressa auth --key pressa_xxx`)
3. If you get an authentication error, ask the user to run `pressa auth` or provide their API key

The API key is stored in `~/.pressa/config.json`.

## Using the CLI

The `pressa` CLI is installed on this machine. Use it via Bash:

```bash
# Compile a LaTeX file
pressa compile document.tex

# Compile with a specific compiler
pressa compile document.tex --compiler xelatex

# Compile from stdin (useful for generated LaTeX)
echo '\documentclass{article}\begin{document}Hello\end{document}' | pressa compile -

# Save to a specific file
pressa compile report.tex --output ~/Documents/report.pdf

# Get JSON output instead of downloading
pressa compile document.tex --json

# Check usage and plan
pressa usage
```

**Note:** When compiling from stdin (`-`), Pressa prints the PDF URL instead of downloading a file. Use `--output` to save to a specific file:
```bash
echo '...' | pressa compile - --output document.pdf
```

## Workflow for creating documents

When the user asks you to create a document:

1. **Understand what they need** — ask clarifying questions if the request is vague
2. **Write a LaTeX file** — create a `.tex` file with professional formatting
3. **Compile with Pressa** — run `pressa compile <file>`
4. **Share the result** — the PDF URL is printed to the terminal
5. **Iterate** — if the user wants changes, edit the LaTeX and recompile

## Handling compilation errors

If `pressa compile` fails:

1. The CLI prints the LaTeX compilation log with the error line highlighted
2. Read the error message — common issues:
   - **Undefined control sequence** — a command or package is misspelled
   - **Missing $ inserted** — math mode characters outside of `$...$`
   - **File not found** — a package needs to be included with `\usepackage{}`
   - **Emergency stop** — usually a syntax error (missing brace, wrong nesting)
3. Fix the LaTeX source and recompile
4. If compilation keeps failing, simplify the document and add complexity incrementally

## LaTeX best practices

- Use `\documentclass{article}` for most documents, `\documentclass{report}` for longer ones
- Use `geometry` package for margins: `\usepackage[margin=1in]{geometry}`
- Use `booktabs` for professional tables: `\toprule`, `\midrule`, `\bottomrule`
- Use `hyperref` for clickable links
- Use `fancyhdr` for headers and footers
- Use `xelatex` compiler when custom fonts are needed
- Use `lualatex` compiler for complex Unicode or font features

## Available compilers

- `pdflatex` (default) — fastest, good for most documents
- `xelatex` — supports system fonts and Unicode
- `lualatex` — most powerful, best for complex typography

## Current limits

> These limits may change. Run `pressa usage` for your current plan details.

- Free plan: 50 compilations per month
- Pro plan: 1,000 compilations per month
- Business plan: 5,000 compilations per month
- Max LaTeX source size: 500KB
- Compilation timeout: 30 seconds
- PDFs expire after 24 hours (signed URLs)

## Example: Creating an invoice

```latex
\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{booktabs}
\usepackage{tabularx}
\usepackage{hyperref}

\begin{document}

\begin{flushright}
\textbf{\Large INVOICE} \\
\vspace{4pt}
Invoice \#001 \\
Date: \today
\end{flushright}

\vspace{20pt}

\textbf{From:} Your Company Name \\
\textbf{To:} Client Company Name \\

\vspace{20pt}

\begin{tabularx}{\textwidth}{Xrrr}
\toprule
\textbf{Description} & \textbf{Hours} & \textbf{Rate} & \textbf{Amount} \\
\midrule
Consulting services & 40 & \$150 & \$6,000 \\
\bottomrule
\end{tabularx}

\vspace{10pt}
\begin{flushright}
\textbf{Total: \$6,000}
\end{flushright}

\vspace{20pt}
\textit{Payment due within 30 days.}

\end{document}
```

Then compile: `pressa compile invoice.tex`
