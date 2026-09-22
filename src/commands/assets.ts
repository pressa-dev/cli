import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { PressaAPI, ApiError } from '../api.js';
import { getApiKey, getApiUrl } from '../config.js';

const ALLOWED_ASSET_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'pdf', 'svg']);
const UPGRADE_URL = 'https://pressa.dev/pricing';

function getApi(urlOverride?: string): PressaAPI {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error(
      chalk.red('Error: No API key configured. Run ') +
        chalk.bold('pressa auth') +
        chalk.red(' or set PRESSA_API_KEY env var.'),
    );
    process.exit(1);
  }
  return new PressaAPI(apiKey, urlOverride || getApiUrl());
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function padEnd(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

function handleApiError(err: unknown, context: { nameOrFile?: string }): never {
  if (err instanceof ApiError) {
    const body = err.body as Record<string, unknown>;
    const code = body.error as string | undefined;
    const message = (body.message as string | undefined) || err.message;

    if (err.status === 401) {
      console.error(chalk.red('Error: Invalid API key. Run ') + chalk.bold('pressa auth') + chalk.red(' to update.'));
      process.exit(1);
    }

    if (code === 'plan_required') {
      console.error(chalk.red('Error: Asset library requires a paid plan (Starter or above).'));
      const upgrade = (body.upgrade_url as string | undefined) || UPGRADE_URL;
      console.error(chalk.cyan(`Upgrade: ${upgrade}`));
      process.exit(1);
    }

    if (code === 'asset_limit_reached') {
      const limit = body.limit;
      const count = body.count;
      console.error(chalk.red(`Error: ${message}`));
      if (typeof limit === 'number' && typeof count === 'number') {
        console.error(chalk.dim(`  Stored assets: ${count}/${limit}`));
      }
      const upgrade = (body.upgrade_url as string | undefined) || UPGRADE_URL;
      console.error(chalk.cyan(`Upgrade: ${upgrade}`));
      process.exit(1);
    }

    if (code === 'storage_quota_exceeded') {
      const sizeBytes = body.size_bytes;
      const remaining = body.remaining_bytes;
      const total = body.total_limit_bytes;
      console.error(chalk.red(`Error: ${message}`));
      if (typeof sizeBytes === 'number' && typeof remaining === 'number' && typeof total === 'number') {
        console.error(
          chalk.dim(
            `  Size: ${formatBytes(sizeBytes)} | Remaining: ${formatBytes(remaining)} | Total quota: ${formatBytes(total)}`,
          ),
        );
      }
      const upgrade = (body.upgrade_url as string | undefined) || UPGRADE_URL;
      console.error(chalk.cyan(`Upgrade: ${upgrade}`));
      process.exit(1);
    }

    if (code === 'invalid_asset_filename') {
      console.error(chalk.red(`Error: Invalid asset filename. ${message}`));
      process.exit(1);
    }

    if (code === 'invalid_asset_format') {
      console.error(chalk.red(`Error: Invalid asset format. ${message}`));
      process.exit(1);
    }

    if (code === 'invalid_asset_encoding') {
      console.error(chalk.red(`Error: Invalid base64 encoding. ${message}`));
      process.exit(1);
    }

    if (err.status === 404 || code === 'not_found') {
      const label = context.nameOrFile ? `"${context.nameOrFile}"` : 'asset';
      console.error(chalk.red(`Error: Asset ${label} not found.`));
      process.exit(1);
    }

    console.error(chalk.red(`Error: ${message}`));
    process.exit(1);
  }

  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(`Error: ${message}`));
  process.exit(1);
}

export const assetsCommand = new Command('assets')
  .description('Manage persistent asset library (images, logos, signatures)')
  .addCommand(
    new Command('list')
      .description('List all stored assets')
      .option('-u, --url <url>', 'API base URL override')
      .option('--json', 'Output as JSON')
      .action(async (options: { url?: string; json?: boolean }) => {
        try {
          const api = getApi(options.url);
          const result = await api.listAssets();

          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          if (result.assets.length === 0) {
            console.log(chalk.dim('No stored assets.'));
            const countDisplay = result.count_limit === null ? 'unlimited' : String(result.count_limit);
            console.log(
              chalk.dim(
                `  0 / ${countDisplay} assets | 0 B / ${formatBytes(result.total_bytes_limit)} used`,
              ),
            );
            return;
          }

          // Column widths
          const nameWidth = Math.max(4, ...result.assets.map((a) => a.name.length));
          const typeWidth = Math.max(4, ...result.assets.map((a) => a.content_type.length));
          const sizeWidth = Math.max(4, ...result.assets.map((a) => formatBytes(a.size_bytes).length));

          const header =
            chalk.bold(padEnd('Name', nameWidth)) +
            '  ' +
            chalk.bold(padEnd('Type', typeWidth)) +
            '  ' +
            chalk.bold(padEnd('Size', sizeWidth)) +
            '  ' +
            chalk.bold('Updated');
          console.log(header);

          for (const a of result.assets) {
            const updated = new Date(a.updated_at).toLocaleDateString();
            console.log(
              padEnd(a.name, nameWidth) +
                '  ' +
                chalk.dim(padEnd(a.content_type, typeWidth)) +
                '  ' +
                padEnd(formatBytes(a.size_bytes), sizeWidth) +
                '  ' +
                chalk.dim(updated),
            );
          }

          console.log();
          const countDisplay = result.count_limit === null ? 'unlimited' : String(result.count_limit);
          const usedBytes = formatBytes(result.total_bytes);
          const totalBytes = formatBytes(result.total_bytes_limit);
          const freeDisplay =
            result.remaining_bytes === null ? 'unlimited' : formatBytes(result.remaining_bytes);
          console.log(
            chalk.dim(
              `  ${result.count} / ${countDisplay} assets | ${usedBytes} / ${totalBytes} used (${freeDisplay} free)`,
            ),
          );
        } catch (err) {
          handleApiError(err, {});
        }
      }),
  )
  .addCommand(
    new Command('upload')
      .description('Upload a file to the asset library (png/jpg/jpeg/pdf/svg)')
      .argument('<file>', 'Local file to upload')
      .option('-n, --name <name>', 'Store under this name (defaults to basename of file)')
      .option('-u, --url <url>', 'API base URL override')
      .option('--json', 'Output response as JSON')
      .action(async (file: string, options: { name?: string; url?: string; json?: boolean }) => {
        try {
          const name = options.name || basename(file);
          const ext = extname(name).slice(1).toLowerCase();
          if (!ALLOWED_ASSET_EXTENSIONS.has(ext)) {
            console.error(
              chalk.red(
                `Error: Unsupported extension ".${ext}". Allowed: png, jpg, jpeg, pdf, svg.`,
              ),
            );
            process.exit(1);
          }

          let bytes: Buffer;
          try {
            bytes = await readFile(resolve(file));
          } catch {
            console.error(chalk.red(`Error: Cannot read file: ${file}`));
            process.exit(1);
            return;
          }

          const contentBase64 = bytes.toString('base64');

          const spinner = options.json ? null : ora(`Uploading ${chalk.bold(name)}...`).start();
          const result = await api(options.url).saveAsset(name, contentBase64).catch((err: unknown) => {
            if (spinner) spinner.fail('Upload failed');
            handleApiError(err, { nameOrFile: name });
          });

          if (!result) return; // handleApiError exits

          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          const action = result.created ? 'Uploaded' : 'Updated';
          spinner!.succeed(
            `${action} ${chalk.bold(result.asset.name)} (${formatBytes(result.asset.size_bytes)})`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Error: ${message}`));
          process.exit(1);
        }
      }),
  )
  .addCommand(
    new Command('get')
      .description('Download an asset by name or ID')
      .argument('<name-or-id>', 'Asset name or numeric ID')
      .option('-o, --output <file>', 'Write binary contents to this file (otherwise stdout)')
      .option('-u, --url <url>', 'API base URL override')
      .option('--json', 'Print metadata JSON (no content)')
      .action(
        async (
          nameOrId: string,
          options: { output?: string; url?: string; json?: boolean },
        ) => {
          try {
            const result = await api(options.url)
              .getAsset(nameOrId)
              .catch((err: unknown) => handleApiError(err, { nameOrFile: nameOrId }));

            if (!result) return;

            if (options.json) {
              const { content_base64: _drop, ...meta } = result.asset;
              console.log(JSON.stringify({ asset: meta }, null, 2));
              return;
            }

            if (!result.asset.content_base64) {
              console.error(chalk.red('Error: Server response missing content_base64.'));
              process.exit(1);
            }

            const buf = Buffer.from(result.asset.content_base64, 'base64');

            if (options.output) {
              await writeFile(resolve(options.output), buf);
              console.log(
                chalk.green('\u2713') +
                  ` Saved ${chalk.bold(result.asset.name)} (${formatBytes(buf.byteLength)}) to ${options.output}`,
              );
            } else {
              if (process.stdout.isTTY) {
                console.error(
                  chalk.yellow(
                    'Warning: writing binary asset to TTY stdout. Use --output <file> to save to disk.',
                  ),
                );
              }
              process.stdout.write(buf);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(chalk.red(`Error: ${message}`));
            process.exit(1);
          }
        },
      ),
  )
  .addCommand(
    new Command('delete')
      .description('Delete a stored asset')
      .argument('<name-or-id>', 'Asset name or numeric ID')
      .option('-y, --yes', 'Skip confirmation')
      .option('-u, --url <url>', 'API base URL override')
      .action(async (nameOrId: string, options: { yes?: boolean; url?: string }) => {
        try {
          if (!options.yes) {
            const { createInterface } = await import('node:readline');
            const rl = createInterface({ input: process.stdin, output: process.stderr });
            const answer = await new Promise<string>((resolve) => {
              rl.question(`Delete asset "${nameOrId}"? This cannot be undone. [y/N] `, resolve);
            });
            rl.close();
            if (answer.toLowerCase() !== 'y') {
              console.log('Cancelled.');
              return;
            }
          }

          await api(options.url)
            .deleteAsset(nameOrId)
            .catch((err: unknown) => handleApiError(err, { nameOrFile: nameOrId }));

          console.log(chalk.green('\u2713') + ` Deleted asset "${nameOrId}"`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`Error: ${message}`));
          process.exit(1);
        }
      }),
  );

function api(urlOverride?: string): PressaAPI {
  return getApi(urlOverride);
}
