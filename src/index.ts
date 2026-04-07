#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { authCommand } from './commands/auth.js';
import { compileCommand } from './commands/compile.js';
import { usageCommand } from './commands/usage.js';

process.on('unhandledRejection', (err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
);

const program = new Command();

program
  .name('pressa')
  .description('Compile-as-a-Service CLI. LaTeX in, PDF out.')
  .version(pkg.version);

program.addCommand(authCommand);
program.addCommand(compileCommand);
program.addCommand(usageCommand);

program.parse();
