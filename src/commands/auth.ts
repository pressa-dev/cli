import { Command } from 'commander';
import chalk from 'chalk';
import { getConfig, saveConfig } from '../config.js';
import { PressaAPI, ApiError } from '../api.js';

async function readLineFromStdin(prompt: string): Promise<string> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export const authCommand = new Command('auth')
  .description('Set your Pressa API key')
  .option('-k, --key <key>', 'API key (non-interactive)')
  .option('-u, --url <url>', 'API base URL override')
  .action(async (options: { key?: string; url?: string }) => {
    try {
      if (!options.key && process.env.PRESSA_API_KEY) {
        console.log(chalk.yellow('Note: PRESSA_API_KEY environment variable is set. Use pressa auth only if you want to save a key to config permanently.'));
      }

      const config = getConfig();

      if (options.url) {
        config.api_url = options.url;
      }

      let apiKey = options.key;

      if (!apiKey) {
        if (!process.stdin.isTTY) {
          console.error(chalk.red('Error: No API key provided. Use --key <key> in non-interactive mode.'));
          process.exit(1);
        }
        apiKey = await readLineFromStdin(`${chalk.bold('?')} Enter your API key: `);
      }

      if (!apiKey) {
        console.error(chalk.red('Error: No API key provided.'));
        process.exit(1);
      }

      // Validate the key by calling usage endpoint
      const api = new PressaAPI(apiKey, config.api_url);

      try {
        const resp = await api.usage();

        config.api_key = apiKey;
        saveConfig(config);

        console.log(chalk.green('\u2713') + ` API key saved to ~/.pressa/config.json`);

        const limit = resp.usage.monthly_limit ?? 'unlimited';
        console.log(
          chalk.green('\u2713') +
            ` Verified: ${chalk.bold(resp.user.username)} (${resp.user.plan} plan, ${resp.usage.compilations_this_month}/${limit} compilations this month)`,
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          console.error(chalk.red('Error: Invalid API key. Please check and try again.'));
          process.exit(1);
        }
        throw err;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error: ${message}`));
      process.exit(1);
    }
  });
