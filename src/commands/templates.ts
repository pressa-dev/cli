import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { PressaAPI, ApiError } from '../api.js';
import { getApiKey, getApiUrl } from '../config.js';

function getApi(urlOverride?: string): PressaAPI {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error(chalk.red('Error: No API key configured. Run `pressa auth` first.'));
    process.exit(1);
  }
  return new PressaAPI(apiKey, urlOverride || getApiUrl());
}

export const templatesCommand = new Command('templates')
  .description('Manage saved LaTeX templates')
  .addCommand(
    new Command('list')
      .description('List all saved templates')
      .option('-u, --url <url>', 'API base URL override')
      .option('--json', 'Output as JSON')
      .action(async (options: { url?: string; json?: boolean }) => {
        try {
          const api = getApi(options.url);
          const result = await api.listTemplates();

          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          if (result.templates.length === 0) {
            console.log(chalk.dim('No saved templates.'));
            return;
          }

          console.log(chalk.bold(`Templates (${result.templates.length}):\n`));
          for (const t of result.templates) {
            const size = t.latex_size_bytes < 1024
              ? `${t.latex_size_bytes}B`
              : `${(t.latex_size_bytes / 1024).toFixed(1)}KB`;
            const instructionsBadge = t.has_instructions ? chalk.cyan(' [instructions]') : '';
            console.log(`  ${chalk.bold(t.name)} ${chalk.dim(`(${size})`)}${instructionsBadge}`);
            if (t.description) {
              console.log(`  ${chalk.dim(t.description)}`);
            }
            console.log(`  ${chalk.dim(`Updated: ${new Date(t.updated_at).toLocaleDateString()}`)}`);
            console.log();
          }
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            console.error(chalk.red('Error: Invalid API key. Run `pressa auth` to reconfigure.'));
            process.exit(1);
          }
          const message = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Error: ${message}`));
          process.exit(1);
        }
      }),
  )
  .addCommand(
    new Command('get')
      .description('Get a template by name or ID')
      .argument('<name-or-id>', 'Template name or numeric ID')
      .option('-o, --output <file>', 'Save LaTeX to file instead of stdout')
      .option('--instructions-out <file>', 'Save template instructions to a separate file (skipped if template has none)')
      .option('-u, --url <url>', 'API base URL override')
      .option('--json', 'Output full template as JSON')
      .action(async (
        nameOrId: string,
        options: { output?: string; instructionsOut?: string; url?: string; json?: boolean },
      ) => {
        try {
          const api = getApi(options.url);
          const result = await api.getTemplate(nameOrId);

          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          if (options.output) {
            writeFileSync(options.output, result.template.latex_content, 'utf-8');
            console.log(chalk.green('\u2713') + ` Saved LaTeX to ${options.output}`);
          } else {
            process.stdout.write(result.template.latex_content);
          }

          if (options.instructionsOut) {
            if (result.template.instructions) {
              writeFileSync(options.instructionsOut, result.template.instructions, 'utf-8');
              console.error(chalk.green('\u2713') + ` Saved instructions to ${options.instructionsOut}`);
            } else {
              console.error(chalk.dim(`(no instructions on this template; ${options.instructionsOut} not written)`));
            }
          } else if (result.template.instructions && options.output) {
            // Hint that instructions exist when writing LaTeX to a file but no instructions destination given
            console.error(
              chalk.cyan('Note:') +
                ' this template has instructions for AI agents. ' +
                'Use --instructions-out <file> or --json to retrieve them.',
            );
          }
        } catch (err) {
          if (err instanceof ApiError) {
            if (err.status === 401) {
              console.error(chalk.red('Error: Invalid API key. Run `pressa auth` to reconfigure.'));
              process.exit(1);
            }
            if (err.status === 404) {
              console.error(chalk.red(`Error: Template "${nameOrId}" not found.`));
              process.exit(1);
            }
          }
          const message = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Error: ${message}`));
          process.exit(1);
        }
      }),
  )
  .addCommand(
    new Command('save')
      .description('Save a LaTeX file as a template')
      .argument('<name>', 'Template name')
      .argument('<file>', 'LaTeX file path (use - for stdin)')
      .option('-d, --description <desc>', 'Template description')
      .option('-i, --instructions <text>', 'Prose markdown rules for AI agents on how to fill this template')
      .option('--instructions-file <file>', 'Read instructions prose from a markdown file')
      .option('-u, --url <url>', 'API base URL override')
      .action(async (
        name: string,
        file: string,
        options: { description?: string; instructions?: string; instructionsFile?: string; url?: string },
      ) => {
        try {
          let latex: string;
          if (file === '-') {
            const chunks: Buffer[] = [];
            for await (const chunk of process.stdin) {
              chunks.push(chunk as Buffer);
            }
            latex = Buffer.concat(chunks).toString('utf-8');
          } else {
            latex = readFileSync(file, 'utf-8');
          }

          if (!latex.trim()) {
            console.error(chalk.red('Error: Empty LaTeX content.'));
            process.exit(1);
          }

          let instructions: string | undefined;
          if (options.instructions !== undefined && options.instructionsFile) {
            console.error(chalk.red('Error: pass either --instructions or --instructions-file, not both.'));
            process.exit(1);
          }
          if (options.instructions !== undefined) {
            instructions = options.instructions;
          } else if (options.instructionsFile) {
            instructions = readFileSync(options.instructionsFile, 'utf-8');
          }

          const api = getApi(options.url);
          const result = await api.saveTemplate(name, latex, options.description, instructions);

          const action = result.created ? 'Created' : 'Updated';
          let instructionsNote = '';
          if (instructions !== undefined) {
            instructionsNote = instructions === ''
              ? chalk.cyan(' (instructions cleared)')
              : chalk.cyan(' (with instructions)');
          }
          console.log(chalk.green('\u2713') + ` ${action} template "${result.template.name}"${instructionsNote}`);
        } catch (err) {
          if (err instanceof ApiError) {
            if (err.status === 401) {
              console.error(chalk.red('Error: Invalid API key. Run `pressa auth` to reconfigure.'));
              process.exit(1);
            }
            if (err.status === 403) {
              const body = err.body as Record<string, unknown>;
              if (body.error === 'template_limit_reached') {
                console.error(chalk.red(`Error: ${body.message || 'Template limit reached.'}`));
                if (body.upgrade_url) {
                  console.error(chalk.cyan(`Upgrade: ${body.upgrade_url}`));
                }
              } else {
                console.error(chalk.red('Error: Saved templates require a paid plan.'));
                console.error(chalk.cyan('Upgrade: https://pressa.dev/pricing'));
              }
              process.exit(1);
            }
          }
          const message = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Error: ${message}`));
          process.exit(1);
        }
      }),
  )
  .addCommand(
    new Command('delete')
      .description('Delete a saved template')
      .argument('<name-or-id>', 'Template name or numeric ID')
      .option('-y, --yes', 'Skip confirmation')
      .option('-u, --url <url>', 'API base URL override')
      .action(async (nameOrId: string, options: { yes?: boolean; url?: string }) => {
        try {
          if (!options.yes) {
            const { createInterface } = await import('node:readline');
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            const answer = await new Promise<string>((resolve) => {
              rl.question(`Delete template "${nameOrId}"? This cannot be undone. [y/N] `, resolve);
            });
            rl.close();
            if (answer.toLowerCase() !== 'y') {
              console.log('Cancelled.');
              return;
            }
          }

          const api = getApi(options.url);
          await api.deleteTemplate(nameOrId);
          console.log(chalk.green('\u2713') + ` Deleted template "${nameOrId}"`);
        } catch (err) {
          if (err instanceof ApiError) {
            if (err.status === 401) {
              console.error(chalk.red('Error: Invalid API key. Run `pressa auth` to reconfigure.'));
              process.exit(1);
            }
            if (err.status === 404) {
              console.error(chalk.red(`Error: Template "${nameOrId}" not found.`));
              process.exit(1);
            }
          }
          const message = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Error: ${message}`));
          process.exit(1);
        }
      }),
  );
