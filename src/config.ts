import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export interface PressaConfig {
  api_key?: string;
  api_url: string;
}

const DEFAULT_CONFIG: PressaConfig = {
  api_url: 'https://api.pressa.dev',
};

export function getConfigDir(): string {
  return join(homedir(), '.pressa');
}

export function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

export function getConfig(): PressaConfig {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const stats = statSync(configPath);
    const mode = stats.mode & 0o777;
    if (mode & 0o077) {
      // File is readable by group or others — warn
      console.warn(
        `Warning: ${configPath} has insecure permissions (${mode.toString(8)}). Run: chmod 600 ${configPath}`,
      );
    }

    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PressaConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function getApiKey(): string | undefined {
  // Environment variable takes priority (safer than --key flag)
  return process.env.PRESSA_API_KEY || getConfig().api_key;
}

export function getApiUrl(): string {
  return process.env.PRESSA_API_URL || getConfig().api_url || 'https://api.pressa.dev';
}

export function saveConfig(config: PressaConfig): void {
  const configPath = getConfigPath();
  const dir = dirname(configPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
}
