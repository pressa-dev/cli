import { Command } from 'commander';
import chalk from 'chalk';
import { getApiKey, getApiUrl } from '../config.js';
import { PressaAPI, ApiError } from '../api.js';

export const usageCommand = new Command('usage')
  .description('Show your API usage statistics')
  .option('-u, --url <url>', 'API base URL override')
  .action(async (options: { url?: string }) => {
    try {
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

      let resp;
      try {
        resp = await api.usage();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          console.error(
            chalk.red('Error: Invalid API key. Run ') +
              chalk.bold('pressa auth') +
              chalk.red(' to update.'),
          );
          process.exit(1);
        }
        throw err;
      }

      const limit = resp.usage.monthly_limit ?? 'unlimited';
      const resetsAt = new Date(resp.usage.resets_at).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      });

      const keyDisplay = `${resp.api_key.prefix}... (${resp.api_key.name || 'Unnamed Key'})`;

      console.log(`Plan:    ${chalk.bold(resp.user.plan)}`);
      console.log(`Used:    ${chalk.bold(String(resp.usage.compilations_this_month))}/${limit} this month`);
      console.log(`Resets:  ${resetsAt}`);
      console.log(`API Key: ${keyDisplay}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error: ${message}`));
      process.exit(1);
    }
  });
