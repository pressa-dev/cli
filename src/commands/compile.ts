import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, isAbsolute } from 'node:path';
import { getApiKey, getApiUrl } from '../config.js';
import { PressaAPI, ApiError, type CompileError } from '../api.js';

// Max total decoded asset payload we're willing to assemble on the client. The server also
// enforces per-plan caps; this is a belt-and-suspenders guard so we don't silently try to
// upload a 500MB folder.
const MAX_ASSETS_TOTAL_BYTES = 100 * 1024 * 1024; // 100MB
const ALLOWED_ASSET_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'pdf', 'svg']);

// Matches \includegraphics[...]{filename} and \includegraphics{filename}. We intentionally
// capture the raw brace content — filenames with spaces or special chars are not supported
// here (nor are they well-supported by pdflatex). Users with edge cases can pass --asset
// explicitly.
const INCLUDEGRAPHICS_RE = /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g;

interface AssetBundle {
  assets: Record<string, string>;
  totalBytes: number;
  resolvedNames: string[];
}

// Auto-detect \includegraphics references in the LaTeX source and bundle matching files
// from the input file's directory. Extensions are inferred if missing (LaTeX convention).
// Filenames that can't be resolved are silently left for the server to handle — pdflatex
// will fail with a clear "File not found" error if the file is genuinely missing.
async function bundleIncludedGraphics(
  latex: string,
  baseDir: string,
  extraAssets: { name: string; path: string }[],
): Promise<AssetBundle> {
  const bundle: Record<string, string> = {};
  let totalBytes = 0;
  const resolvedNames: string[] = [];

  const seen = new Set<string>();
  const refs: string[] = [];
  for (const match of latex.matchAll(INCLUDEGRAPHICS_RE)) {
    refs.push(match[1].trim());
  }

  // Resolve each reference. LaTeX lets you omit the extension; we try the common ones.
  for (const ref of refs) {
    const extMatch = ref.match(/\.([^.]+)$/);
    const candidates = extMatch
      ? [ref]
      : ['png', 'jpg', 'jpeg', 'pdf', 'svg'].map((e) => `${ref}.${e}`);

    let resolved: { name: string; path: string } | null = null;
    for (const candidate of candidates) {
      const absPath = isAbsolute(candidate) ? candidate : resolve(baseDir, candidate);
      try {
        await readFile(absPath);
        resolved = { name: basename(candidate), path: absPath };
        break;
      } catch {
        // not found, try next extension
      }
    }
    if (!resolved) continue;
    if (seen.has(resolved.name)) continue;
    seen.add(resolved.name);

    const ext = resolved.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOWED_ASSET_EXTENSIONS.has(ext)) continue;

    const bytes = await readFile(resolved.path);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_ASSETS_TOTAL_BYTES) {
      throw new Error(
        `Total asset size exceeds ${MAX_ASSETS_TOTAL_BYTES} bytes. Consider reducing image sizes.`,
      );
    }
    bundle[resolved.name] = bytes.toString('base64');
    resolvedNames.push(resolved.name);
  }

  // Explicit --asset flags win over auto-detected (overwrite same name) and can add
  // files that aren't referenced by \includegraphics (e.g. \input{}'d files are not
  // supported here, but users can still pass arbitrary extras).
  for (const extra of extraAssets) {
    if (seen.has(extra.name)) continue;
    seen.add(extra.name);
    const ext = extra.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOWED_ASSET_EXTENSIONS.has(ext)) {
      throw new Error(
        `Asset '${extra.name}' has unsupported extension. Allowed: png, jpg, jpeg, pdf, svg.`,
      );
    }
    const bytes = await readFile(extra.path);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_ASSETS_TOTAL_BYTES) {
      throw new Error(
        `Total asset size exceeds ${MAX_ASSETS_TOTAL_BYTES} bytes. Consider reducing image sizes.`,
      );
    }
    bundle[extra.name] = bytes.toString('base64');
    resolvedNames.push(extra.name);
  }

  return { assets: bundle, totalBytes, resolvedNames };
}

// Parse one --asset spec. Supported forms:
//   --asset logo.png               (filename only, reads ./logo.png, sent as logo.png)
//   --asset logo=/path/to/real.png (explicit name mapping)
function parseAssetSpec(spec: string, baseDir: string): { name: string; path: string } {
  const eq = spec.indexOf('=');
  if (eq === -1) {
    const abs = isAbsolute(spec) ? spec : resolve(baseDir, spec);
    return { name: basename(spec), path: abs };
  }
  const name = spec.slice(0, eq).trim();
  const pathPart = spec.slice(eq + 1).trim();
  const abs = isAbsolute(pathPart) ? pathPart : resolve(baseDir, pathPart);
  return { name, path: abs };
}

async function readStdin(): Promise<string> {
  const MAX_SIZE = 512 * 1024; // 512KB (slightly over 500KB limit to allow for the check)
  const chunks: Buffer[] = [];
  let totalSize = 0;

  for await (const chunk of process.stdin) {
    totalSize += chunk.length;
    if (totalSize > MAX_SIZE) {
      throw new Error('Input exceeds maximum size (500KB).');
    }
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf-8');
}

function getOutputFilename(inputPath: string, outputOption?: string): string {
  if (outputOption) {
    return resolve(outputOption);
  }
  const name = basename(inputPath, '.tex');
  return resolve(`${name}.pdf`);
}

/**
 * Render the server's structured compile diagnosis (LatexErrorParser).
 *
 * The raw TeX log is what a human reads; this is the actionable version, and
 * it is what makes "fix it and retry" possible without a person in the loop.
 * Silent when the server did not classify the failure - the server declines to
 * guess, and echoing an empty section would just add noise.
 */
function printDiagnosis(body: Record<string, unknown>): void {
  const d = body.diagnosis as Record<string, unknown> | undefined;
  if (!d) return;

  console.error('');
  if (typeof d.suggested_fix === 'string') {
    console.error(chalk.yellow('Suggested fix: ') + d.suggested_fix);
  }
  if (typeof d.suggested_package === 'string') {
    console.error(chalk.dim(`  add: \\usepackage{${d.suggested_package}}`));
  }
  if (typeof d.symbol === 'string') {
    console.error(chalk.dim(`  at: ${d.symbol}${d.line ? ` (line ${d.line})` : ''}`));
  }
}

/**
 * Render the server's `next_step` block. This is what turns a dead end into a
 * recoverable one: it names the concrete action (get a key, drop the assets)
 * rather than leaving the caller with a status code.
 */
function printNextStep(body: Record<string, unknown>): void {
  const n = body.next_step as Record<string, unknown> | undefined;
  if (!n) return;

  console.error('');
  if (typeof n.signup_url === 'string') {
    console.error(chalk.cyan(`Get a free API key: ${n.signup_url}`));
    if (n.card_required === false) {
      console.error(chalk.dim('  about 30 seconds, no credit card'));
    }
    console.error(chalk.dim('  then run: pressa auth'));
  }
  if (Array.isArray(n.remove_fields)) {
    console.error(chalk.dim(`  or retry without: ${(n.remove_fields as string[]).join(', ')}`));
  }
}

function formatCompileError(body: Record<string, unknown>): string {
  const err = body as unknown as CompileError;
  const lines: string[] = [];

  lines.push(chalk.red(`Compilation failed: ${err.error}`));

  if (err.log) {
    lines.push('');
    lines.push(chalk.dim('--- Compilation log ---'));

    const logLines = err.log.split('\n');
    for (const line of logLines) {
      if (err.error_line && line.includes(`l.${err.error_line}`)) {
        lines.push(chalk.red.bold(`> ${line}`));
      } else if (line.startsWith('!')) {
        lines.push(chalk.red(line));
      } else {
        lines.push(chalk.dim(line));
      }
    }
    lines.push(chalk.dim('--- End of log ---'));

    // Surface a hint when the error is the classic "user submitted plain text" case.
    // This is a safety net in case the input slipped past the server's not_latex_source gate
    // (e.g. has \input{...} but no real document body).
    if (err.log.includes('Missing \\begin{document}')) {
      lines.push('');
      lines.push(
        chalk.yellow(
          'Hint: "Missing \\begin{document}" usually means the input was not LaTeX. ' +
            'Pressa compiles LaTeX source code, not plain text or markdown. ' +
            'Wrap content in \\documentclass{article}\\begin{document}...\\end{document} ' +
            'and escape special characters (% & $ # _ { }).',
        ),
      );
    }
  }

  return lines.join('\n');
}

// Quick structural check mirroring the server's looks_like_latex? gate. We keep it
// here so the CLI can warn before sending and avoid a wasted round-trip.
const LATEX_MARKERS = ['\\documentclass', '\\begin{document}', '\\input{', '\\include{'];

function looksLikeLatex(source: string): boolean {
  return LATEX_MARKERS.some((marker) => source.includes(marker));
}

export const compileCommand = new Command('compile')
  .description('Compile a LaTeX file to PDF')
  .argument('<file>', 'LaTeX file to compile (use - for stdin)')
  .option('-c, --compiler <compiler>', 'LaTeX compiler: pdflatex, xelatex, lualatex (Pro+)', 'pdflatex')
  .option('-o, --output <file>', 'Output PDF filename')
  .option('--json', 'Output machine-readable JSON (for AI agents)')
  .option('--no-download', 'Do not download PDF, just return URL')
  .option('--no-bundle', 'Disable auto-bundling of \\includegraphics assets')
  .option(
    '-a, --asset <spec...>',
    'Include an asset file (png/jpg/jpeg/pdf/svg). Forms: "logo.png" or "logo.png=/path/to/file.png". Repeatable.',
  )
  .option(
    '-s, --stored-asset <name...>',
    'Use a stored asset from the asset library by name (e.g. "logo.png"). Repeatable.',
  )
  .option('-u, --url <url>', 'API base URL override')
  .action(
    async (
      file: string,
      options: {
        compiler: string;
        output?: string;
        json?: boolean;
        download: boolean;
        bundle: boolean;
        asset?: string[];
        storedAsset?: string[];
        url?: string;
      },
    ) => {
      try {
        const VALID_COMPILERS = ['pdflatex', 'xelatex', 'lualatex'];
        if (!VALID_COMPILERS.includes(options.compiler)) {
          console.error(chalk.red(`Error: Invalid compiler "${options.compiler}". Use: ${VALID_COMPILERS.join(', ')}`));
          process.exit(1);
        }

        const apiKey = getApiKey();
        const apiUrl = options.url || getApiUrl();

        // No key is not an error. It selects the anonymous tier, so an agent
        // (or a first-time human) can compile immediately instead of stopping
        // to do setup. Aborting here is exactly the friction that sends a
        // caller to pandoc or headless Chrome, neither of which needs a key.
        if (!apiKey && !options.json) {
          console.error(
            chalk.dim(
              'No API key configured - compiling anonymously (pdflatex, max 3 pages, ' +
                'no image assets, small daily allowance). Run ',
            ) +
              chalk.bold('pressa auth') +
              chalk.dim(' for the full free tier.'),
          );
        }

        const api = new PressaAPI(apiKey ?? null, apiUrl);

        // Read LaTeX source
        let latex: string;
        let inputName: string;

        if (file === '-') {
          if (process.stdin.isTTY) {
            console.error(chalk.dim('Reading LaTeX from stdin... (press Ctrl+D when done)'));
          }
          latex = await readStdin();
          inputName = 'stdin';
        } else {
          try {
            latex = await readFile(resolve(file), 'utf-8');
            inputName = basename(file);
          } catch {
            console.error(chalk.red(`Error: Cannot read file: ${file}`));
            process.exit(1);
            return; // unreachable, helps TS narrow
          }
        }

        // Client-side size validation
        const MAX_LATEX_SIZE = 500 * 1024;
        if (Buffer.byteLength(latex, 'utf-8') > MAX_LATEX_SIZE) {
          console.error(chalk.red('Error: LaTeX source exceeds 500KB limit.'));
          process.exit(1);
        }

        // Pre-flight: warn (but still send) if the input does not look like LaTeX.
        // The server has the same gate and will reject with not_latex_source, but the
        // local warning catches the common "I gave it a .txt or .md file" mistake
        // before we even hit the network.
        if (!looksLikeLatex(latex) && !options.json) {
          console.error(
            chalk.yellow(
              `Warning: ${inputName} does not contain LaTeX markers (\\documentclass, ` +
                `\\begin{document}, \\input, or \\include). Pressa compiles LaTeX source ` +
                `code, not plain text or markdown. The server will likely reject this with ` +
                `not_latex_source. If you want a PDF from non-LaTeX content, generate the ` +
                `LaTeX yourself first (or ask an LLM to do it).`,
            ),
          );
        }

        // Bundle assets (from \includegraphics auto-detection + explicit --asset flags).
        // stdin compiles skip auto-detection (no baseDir). Explicit --asset still works
        // if user passes an absolute path.
        let assets: Record<string, string> | undefined;
        try {
          const baseDir = file === '-' ? process.cwd() : dirname(resolve(file));
          const extraAssetSpecs = (options.asset ?? []).map((spec) => parseAssetSpec(spec, baseDir));
          const shouldAutoBundle = options.bundle !== false && file !== '-';

          if (shouldAutoBundle || extraAssetSpecs.length > 0) {
            const bundle = await bundleIncludedGraphics(
              latex,
              baseDir,
              shouldAutoBundle ? extraAssetSpecs : extraAssetSpecs,
            );
            if (Object.keys(bundle.assets).length > 0) {
              assets = bundle.assets;
              if (!options.json) {
                console.error(
                  chalk.dim(
                    `  Bundled ${bundle.resolvedNames.length} asset${bundle.resolvedNames.length === 1 ? '' : 's'}: ${bundle.resolvedNames.join(', ')}`,
                  ),
                );
              }
            }
          } else if (!shouldAutoBundle && extraAssetSpecs.length === 0) {
            // bundle explicitly disabled and no --asset: send nothing
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Error bundling assets: ${message}`));
          process.exit(1);
        }

        // Compile
        const spinner = options.json
          ? null
          : ora(`Compiling ${chalk.bold(inputName)} with ${options.compiler}...`).start();

        const result = await api.compile(latex, options.compiler, assets, options.storedAsset).catch((err: unknown) => {
          if (err instanceof ApiError) {
            const body = err.body as unknown as CompileError;
            const failMsg = body.error === 'not_latex_source' ? 'Rejected: not LaTeX source'
              : body.error === 'compiler_not_available' ? 'Rejected: compiler not available'
              : body.error === 'latex_too_large' ? 'Rejected: source too large'
              : body.error === 'page_limit_exceeded' ? 'Rejected: too many pages'
              : body.error === 'pdf_too_large' ? 'Rejected: PDF too large'
              : body.error === 'assets_not_allowed' ? 'Rejected: assets not allowed on plan'
              : body.error === 'assets_too_large' ? 'Rejected: assets too large'
              : body.error === 'too_many_assets' ? 'Rejected: too many assets'
              : body.error === 'invalid_asset_filename' ? 'Rejected: invalid asset filename'
              : body.error === 'invalid_asset_format' ? 'Rejected: invalid asset format'
              : body.error === 'invalid_asset_encoding' ? 'Rejected: invalid asset encoding'
              : body.error === 'invalid_asset_shape' ? 'Rejected: invalid asset shape'
              : body.error === 'asset_not_found' ? 'Rejected: stored asset not found'
              : body.error === 'asset_name_collision' ? 'Rejected: asset name collision'
              : body.error === 'invalid_stored_assets_shape' ? 'Rejected: invalid use_stored_assets shape'
              : body.error === 'rate_limit_exceeded' || body.error === 'rate_limit' ? 'Rate limit exceeded'
              : 'Compilation failed';
            if (spinner) spinner.fail(failMsg);

            // Error codes whose message is self-explanatory (fix the request — no upgrade needed).
            const nonQuotaErrors = new Set([
              'asset_not_found',
              'asset_name_collision',
              'invalid_stored_assets_shape',
            ]);
            const isNonQuotaStoredError =
              typeof body.error === 'string' && nonQuotaErrors.has(body.error);

            const hasQuotaMessage =
              !isNonQuotaStoredError &&
              (err.status === 403 || err.status === 413 || err.status === 422) &&
              typeof body.message === 'string' &&
              !body.log;

            if (err.status === 401) {
              console.error(
                chalk.red('Error: Invalid API key. Run ') +
                  chalk.bold('pressa auth') +
                  chalk.red(' to update.'),
              );
            } else if (err.status === 422 && body.error === 'not_latex_source') {
              console.error(chalk.red(`Error: ${body.message}`));
              const reqs = (err.body as Record<string, unknown>).requirements;
              if (Array.isArray(reqs) && reqs.length > 0) {
                console.error(chalk.yellow('\nRequirements:'));
                for (const req of reqs) {
                  console.error(chalk.yellow(`  - ${req}`));
                }
              }
              const tmpl = (err.body as Record<string, unknown>).example_template;
              if (typeof tmpl === 'string' && tmpl.length > 0) {
                console.error(chalk.dim(`\nExample template:\n${tmpl}`));
              }
            } else if (hasQuotaMessage) {
              console.error(chalk.red(`Error: ${body.message}`));
              if (body.upgrade_url) {
                console.error(chalk.cyan(`Upgrade: ${body.upgrade_url}`));
              }
            } else if (isNonQuotaStoredError) {
              const msg = typeof body.message === 'string' ? body.message : err.message;
              console.error(chalk.red(`Error: ${msg}`));
            } else if (err.status === 422) {
              // Diagnosis first. The raw log can run to hundreds of lines and
              // the one actionable sentence must not be buried under it.
              printDiagnosis(err.body as Record<string, unknown>);
              console.error(formatCompileError(err.body));
              printNextStep(err.body as Record<string, unknown>);
            } else if (err.status === 429 || err.status === 503) {
              const msg = typeof body.message === 'string' ? body.message : 'Quota exceeded.';
              console.error(chalk.red(`Error: ${msg}`));
              printNextStep(err.body as Record<string, unknown>);
            } else {
              console.error(chalk.red(`Error: ${err.message}`));
            }
          } else {
            if (spinner) spinner.fail('Compilation failed');
            const message = err instanceof Error ? err.message : String(err);
            console.error(chalk.red(`Error: ${message}`));
          }
          process.exit(1);
        });

        // JSON output mode
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        spinner!.succeed(`Compiled in ${result.compilation_time_ms}ms (${result.pages} page${result.pages !== 1 ? 's' : ''})`);

        // A preview: the document is over the plan's limit and this PDF is
        // what the plan delivers of it. Say so before the download line, so a
        // user who only reads the last lines still sees it.
        if (result.preview && result.warning) {
          console.error(chalk.yellow(`Preview: ${result.warning}`));
        }

        // Download PDF
        if (options.download && (file !== '-' || options.output)) {
          const outputPath = getOutputFilename(file, options.output);

          const dlSpinner = ora('Downloading PDF...').start();
          try {
            const pdfData = await api.downloadPdf(result.pdf_url);
            await writeFile(outputPath, Buffer.from(pdfData));
            dlSpinner.succeed(`Downloaded: ${chalk.bold(basename(outputPath))}`);
          } catch (err) {
            dlSpinner.fail('Download failed');
            const message = err instanceof Error ? err.message : String(err);
            console.error(chalk.red(`Error: ${message}`));
            console.log(`PDF URL: ${result.pdf_url}`);
          }
        } else {
          console.log(`${chalk.green('\u2713')} PDF URL: ${result.pdf_url}`);
        }

        if (result.stored_assets_used && result.stored_assets_used.length > 0) {
          console.log(
            chalk.dim(
              `  Stored assets used: ${result.stored_assets_used.join(', ')}`,
            ),
          );
        }

        // Show usage
        const anonUsage = result.usage as unknown as Record<string, unknown> | undefined;
        if (anonUsage && anonUsage.plan === 'anonymous') {
          // The anonymous tier meters per day, not per month, and reports under
          // different keys. Reading the monthly fields here printed
          // "undefined/unlimited this month".
          console.log(
            chalk.dim(
              `  Usage: ${anonUsage.compilations_today}/${anonUsage.daily_limit} today (anonymous)`,
            ),
          );
          console.log(
            chalk.dim('  Run ') + chalk.bold('pressa auth') + chalk.dim(' for 50 compilations/month, images and templates.'),
          );
        } else if (result.usage) {
          const limit = result.usage.monthly_limit ?? 'unlimited';
          console.log(
            chalk.dim(`  Usage: ${result.usage.compilations_this_month}/${limit} this month`),
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
      }
    },
  );
