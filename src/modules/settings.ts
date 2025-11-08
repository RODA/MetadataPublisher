import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

function storePath(): string {
  const dir = app.getPath('userData');
  return path.join(dir, 'settings.json');
}

function readStore(): Record<string, unknown> {
  try {
    const file = storePath();
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeStore(obj: Record<string, unknown>) {
  try {
    const file = storePath();
    // userData dir should exist, but ensure parent anyway
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch {
    // noop: avoid hard-failing app on settings write issues
  }
}

export const settings = {
  get(key: string): unknown {
    const data = readStore();
    return Object.prototype.hasOwnProperty.call(data, key) ? (data as any)[key] : undefined;
  },
  set(key: string, value: unknown): void {
    const data = readStore();
    (data as any)[key] = value;
    writeStore(data);
  },
};

export default settings;

