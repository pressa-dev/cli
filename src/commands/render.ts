import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getApiKey, getApiUrl } from '../config.js';
import { PressaAPI, ApiError, type RenderResponse } from '../api.js';

const MAX_DATA_SIZE = 512 * 1024; // 512KB - matches stdin reader for compile

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let totalSize = 0;

  for await (const chunk of process.stdin) {
    totalSize += chunk.length;
    if (totalSize > MAX_DATA_SIZE) {
      throw new Error('Input data exceeds maximum size (500KB).');
    }
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf-8');
}

// Resolve --data into a raw JSON string. Three forms supported:
//   1. Inline JSON (starts with '{') - parsed directly.
//   2. '-' - read from stdin.
//   3. Anything else - treated as a file path.
async function resolveDataSource(source: string): Promise<string> {
  const trimmed = source.trim();
  if (trimmed.startsWith('{')) {
    return source;
  }
  if (source === '-') {
    return readStdin();
  }
  try {
    return await readFile(resolve(source), 'utf-8');
  } catch {
    throw new Error(`Cannot read data file: ${source}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Sanitize a template name into a safe filesystem default (alphanumeric + dash + underscore).
function defaultOutputName(templateName: string): string {
  const sanitized = templateName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = sanitized.length > 0 ? sanitized : 'rendered';
  return `${base}.pdf`;
}

// When --output is '-', everything decorative goes to stderr and only PDF bytes hit stdout.
function logInfo(stdoutIsBinary: boolean, message: string): void {
  if (stdoutIsBinary) {
    console.error(message);
  } else {
    console.log(message);
  }
}

interface RenderErrorBody {
  error?: string;
  message?: string;
  upgrade_url?: string;
  plan?: string;
  log?: string;
  line?: number;
  missing_fields?: unknown;
  type_errors?: unknown;
  limit?: unknown;
  pages?: unknown;
  used?: unknown;
  resets_at?: unknown;
  rejection_reason?: unknown;
}

function formatRenderError(status: number, body: RenderErrorBody): string {
  const lines: string[] = [];
  const code = body.error ?? `http_${status}`;
  const message = body.message ?? `Render failed (HTTP ${status})`;

  switch (code) {
    case 'unauthorized': {
      lines.push(chalk.red('Error: Invalid or missing API key. Run ') + chalk.bold('pressa auth') + chalk.red(' to update.'));
      break;
    }
    case 'plan_required': {
      lines.push(chalk.red(`Error: ${message}`));
      if (body.upgrade_url) {
        lines.push(chalk.cyan(`Upgrade: ${body.upgrade_url}`));
      }
      break;
    }
    case 'not_found': {
      lines.push(chalk.red(`Error: ${message}`));
      break;
    }
    case 'template_engine_mismatch': {
      lines.push(chalk.red(`Error: ${message}`));
      lines.push(
        chalk.yellow(
          'Hint: render only works on V2 (Liquid placeholder) templates. ' +
            'V1 LaTeX-only templates use the compile endpoint instead. ' +
            'Convert this template via Pressa Studio or save a new V2 template.',
        ),
      );
      break;
    }
    case 'invalid_data_shape': {
      lines.push(chalk.red(`Error: ${message}`));
      lines.push(chalk.yellow('Hint: --data must be a JSON object (e.g. {"name":"Acme","amount":42}).'));
      break;
    }
    case 'schema_validation_failed': {
      lines.push(chalk.red(`Error: ${message}`));
      if (Array.isArray(body.missing_fields) && body.missing_fields.length > 0) {
        lines.push(chalk.yellow('Missing fields:'));
        for (const field of body.missing_fields) {
          if (typeof field === 'string') {
            lines.push(chalk.yellow(`  - ${field}`));
          } else {
            lines.push(chalk.yellow(`  - ${JSON.stringify(field)}`));
          }
        }
      }
      if (Array.isArray(body.type_errors) && body.type_errors.length > 0) {
        lines.push(chalk.yellow('Type errors:'));
        for (const err of body.type_errors) {
          if (typeof err === 'string') {
            lines.push(chalk.yellow(`  - ${err}`));
          } else {
            lines.push(chalk.yellow(`  - ${JSON.stringify(err)}`));
          }
        }
      }
      break;
    }
    case 'render_parse_failed': {
      lines.push(chalk.red(`Error: ${message}`));
      lines.push(chalk.yellow('Hint: the template contains invalid Liquid syntax. Edit the template and retry.'));
      break;
    }
    case 'render_timeout': {
      lines.push(chalk.red(`Error: ${message}`));
      lines.push(chalk.yellow('Hint: Liquid render exceeded 5s. Simplify loops or reduce data size.'));
      break;
    }
    case 'render_asset_not_found': {
      lines.push(chalk.red(`Error: ${message}`));
      lines.push(chalk.yellow('Hint: the template references an asset by name that is not in the library. Save it via `pressa assets save` and retry.'));
      break;
    }
    case 'render_failed': {
      lines.push(chalk.red(`Error: ${message}`));
      if (body.log) {
        lines.push('');
        lines.push(chalk.dim('--- Render log ---'));
        lines.push(chalk.dim(String(body.log)));
        lines.push(chalk.dim('--- End of log ---'));
      }
      break;
    }
    case 'page_limit_exceeded': {
      lines.push(chalk.red(`Error: ${message}`));
      if (body.limit !== undefined && body.pages !== undefined) {
        lines.push(chalk.yellow(`  Page limit: ${String(body.limit)}, document had ${String(body.pages)}.`));
      }
      if (body.upgrade_url) {
        lines.push(chalk.cyan(`Upgrade: ${body.upgrade_url}`));
      }
      break;
    }
    case 'pdf_too_large': {
      lines.push(chalk.red(`Error: ${message}`));
      if (body.rejection_reason) {
        lines.push(chalk.dim(`  Reason: ${String(body.rejection_reason)}`));
      }
      break;
    }
    case 'compilation_failed': {
      lines.push(chalk.red(`Error: ${message}`));
      if (body.log) {
        lines.push('');
        lines.push(chalk.dim('--- Compilation log ---'));
        const logLines = String(body.log).split('\n');
        for (const line of logLines) {
          if (body.line !== undefined && line.includes(`l.${String(body.line)}`)) {
            lines.push(chalk.red.bold(`> ${line}`));
          } else if (line.startsWith('!')) {
            lines.push(chalk.red(line));
          } else {
            lines.push(chalk.dim(line));
          }
        }
        lines.push(chalk.dim('--- End of log ---'));
      }
      break;
    }
    case 'compilation_timeout': {
      lines.push(chalk.red(`Error: ${message}`));
      lines.push(chalk.yellow('Hint: LaTeX compile exceeded the per-plan timeout. Simplify the document or upgrade.'));
      break;
    }
    case 'rate_limit': {
      lines.push(chalk.red(`Error: ${message}`));
      if (body.limit !== undefined && body.used !== undefined) {
        lines.push(chalk.yellow(`  Used ${String(body.used)} of ${String(body.limit)} this month.`));
      }
      if (body.resets_at) {
        lines.push(chalk.yellow(`  Resets at: ${String(body.resets_at)}`));
      }
      if (body.upgrade_url) {
        lines.push(chalk.cyan(`Upgrade: ${body.upgrade_url}`));
      }
      break;
    }
    case 'render_total_timeout': {
      lines.push(chalk.red('Error: Render exceeded 60s. Simplify the template or split the data.'));
      break;
    }
    default: {
      lines.push(chalk.red(`Error: ${message}`));
      if (body.upgrade_url) {
        lines.push(chalk.cyan(`Upgrade: ${body.upgrade_url}`));
      }
      if (body.log) {
        lines.push('');
        lines.push(chalk.dim('--- Log ---'));
        lines.push(chalk.dim(String(body.log)));
        lines.push(chalk.dim('--- End of log ---'));
      }
      break;
    }
  }

  return lines.join('\n');
}

interface RenderOptions {
  data?: string;
  output?: string;
  json?: boolean;
  download: boolean;
  url?: string;
}

export const renderCommand = new Command('render')
  .description('Render a saved V2 template with placeholder data')
  .argument('<template>', 'V2 template numeric ID or name')
  .option('-d, --data <source>', 'Placeholder data: path to JSON file, "-" for stdin, or inline JSON starting with "{"')
  .option('-o, --output <file>', 'Output PDF filename ("-" writes binary to stdout)')
  .option('--json', 'Output machine-readable JSON (for AI agents)')
  .option('--no-download', 'Do not download PDF, just return URL')
  .option('-u, --url <url>', 'API base URL override')
  .action(async (template: string, options: RenderOptions) => {
    const stdoutIsBinary = options.output === '-';

    try {
      if (!options.data) {
        console.error(chalk.red('Error: --data is required. Pass a JSON file path, "-" for stdin, or inline JSON.'));
        process.exit(1);
        return;
      }

      const apiKey = getApiKey();
      const apiUrl = options.url || getApiUrl();

      if (!apiKey) {
        console.error(
          chalk.red('Error: No API key configured. Run ') +
            chalk.bold('pressa auth') +
            chalk.red(' or set PRESSA_API_KEY env var.'),
        );
        process.exit(1);
        return;
      }

      // Read data source (file / stdin / inline JSON).
      let rawData: string;
      try {
        if (options.data === '-' && process.stdin.isTTY && !options.json) {
          console.error(chalk.dim('Reading JSON data from stdin... (press Ctrl+D when done)'));
        }
        rawData = await resolveDataSource(options.data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        process.exit(1);
        return;
      }

      if (Buffer.byteLength(rawData, 'utf-8') > MAX_DATA_SIZE) {
        console.error(chalk.red('Error: Data payload exceeds 500KB limit.'));
        process.exit(1);
        return;
      }

      // Parse + validate shape.
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawData);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: --data is not valid JSON. ${message}`));
        process.exit(1);
        return;
      }

      if (!isPlainObject(parsed)) {
        console.error(chalk.red('Error: --data must be a JSON object (not an array, string, number, or null).'));
        process.exit(1);
        return;
      }

      const data = parsed;

      const api = new PressaAPI(apiKey, apiUrl);

      const showSpinner = !options.json && !stdoutIsBinary;
      const spinner = showSpinner ? ora(`Rendering template ${chalk.bold(template)}...`).start() : null;

      let result: RenderResponse;
      try {
        result = await api.renderTemplate(template, data);
      } catch (err) {
        if (spinner) spinner.fail('Render failed');
        if (err instanceof ApiError) {
          const body = err.body as RenderErrorBody;
          console.error(formatRenderError(err.status, body));
        } else {
          const message = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Error: ${message}`));
        }
        process.exit(1);
        return;
      }

      if (spinner) {
        spinner.succeed(
          `Rendered in ${result.render_time_ms}ms (${result.pages} page${result.pages !== 1 ? 's' : ''}, template '${result.template.name}' v${result.template.version})`,
        );
      }

      // JSON mode - dump full response and exit.
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      // --no-download - just print the URL.
      if (!options.download) {
        logInfo(stdoutIsBinary, `${chalk.green('✓')} PDF URL: ${result.pdf_url}`);
        if (result.usage) {
          const limit = result.usage.monthly_limit ?? 'unlimited';
          logInfo(
            stdoutIsBinary,
            chalk.dim(`  Usage: ${result.usage.compilations_this_month}/${limit} this month`),
          );
        }
        return;
      }

      // Download PDF.
      let pdfData: ArrayBuffer;
      try {
        if (showSpinner) {
          const dlSpinner = ora('Downloading PDF...').start();
          try {
            pdfData = await api.downloadPdf(result.pdf_url);
            dlSpinner.succeed('PDF downloaded');
          } catch (dlErr) {
            dlSpinner.fail('Download failed');
            throw dlErr;
          }
        } else {
          pdfData = await api.downloadPdf(result.pdf_url);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error: ${message}`));
        console.error(`PDF URL: ${result.pdf_url}`);
        process.exit(1);
        return;
      }

      // Write PDF to stdout or to a file.
      if (stdoutIsBinary) {
        process.stdout.write(Buffer.from(pdfData));
      } else {
        const outputPath = options.output
          ? resolve(options.output)
          : resolve(defaultOutputName(result.template.name));
        try {
          await writeFile(outputPath, Buffer.from(pdfData));
          console.log(`${chalk.green('✓')} Saved PDF to ${chalk.bold(outputPath)}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Error: Failed to write PDF: ${message}`));
          console.error(`PDF URL: ${result.pdf_url}`);
          process.exit(1);
          return;
        }
      }

      // Usage hint.
      if (result.usage) {
        const limit = result.usage.monthly_limit ?? 'unlimited';
        logInfo(
          stdoutIsBinary,
          chalk.dim(`  Usage: ${result.usage.compilations_this_month}/${limit} this month`),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error: ${message}`));
      process.exit(1);
    }
  });
