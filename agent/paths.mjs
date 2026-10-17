// Where the agent keeps its files. Env overrides let tests and the local e2e run in a scratch directory.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PLANS_DIR = process.env.FOREMAN_PLANS_DIR || join(ROOT, 'plans');
export const STATE_DIR = process.env.FOREMAN_STATE_DIR || join(ROOT, 'state');
export const LOG_DIR = process.env.FOREMAN_LOG_DIR || join(ROOT, 'log');
export const WEB_DATA_DIR = process.env.FOREMAN_WEB_DATA_DIR || join(ROOT, 'web', 'data');
