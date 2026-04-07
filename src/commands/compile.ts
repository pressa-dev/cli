import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { getApiKey, getApiUrl } from '../config.js';
import { PressaAPI, ApiError, type CompileError } from '../api.js';

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
  }

  return lines.join('\n');
}

export const compileCommand = new Command('compile')
  .description('Compile a LaTeX file to PDF')
  .argument('<file>', 'LaTeX file to compile (use - for stdin)')
  .option('-c, --compiler <compiler>', 'LaTeX compiler: pdflatex, xelatex, lualatex', 'pdflatex')
  .option('-o, --output <file>', 'Output PDF filename')
  .option('--json', 'Output machine-readable JSON (for AI agents)')
  .option('--no-download', 'Do not download PDF, just return URL')
  .option('-u, --url <url>', 'API base URL override')
  .action(
    async (
      file: string,
      options: {
        compiler: string;
        output?: string;
        json?: boolean;
        download: boolean;
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

        if (!apiKey) {
          console.error(
            chalk.red('Error: No API key configured. Run ') +
              chalk.bold('pressa auth') +
              chalk.red(' or set PRESSA_API_KEY env var.'),
          );
          process.exit(1);
          return; // unreachable, helps TS narrow
        }

        const api = new PressaAPI(apiKey, apiUrl);

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

        // Compile
        const spinner = options.json
          ? null
          : ora(`Compiling ${chalk.bold(inputName)} with ${options.compiler}...`).start();

        const result = await api.compile(latex, options.compiler).catch((err: unknown) => {
          if (spinner) spinner.fail('Compilation failed');

          if (err instanceof ApiError) {
            if (err.status === 401) {
              console.error(
                chalk.red('Error: Invalid API key. Run ') +
                  chalk.bold('pressa auth') +
                  chalk.red(' to update.'),
              );
            } else if (err.status === 422) {
              console.error(formatCompileError(err.body));
            } else if (err.status === 429) {
              console.error(chalk.red('Error: Rate limit exceeded. Upgrade your plan or wait until next month.'));
            } else {
              console.error(chalk.red(`Error: ${err.message}`));
            }
          } else {
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

        // Show usage
        if (result.usage) {
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
