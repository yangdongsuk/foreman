// One entry point for every model call in Foreman: askJSON({ system, prompt, schema, model }).
// Always returns an object that matches `schema` (forced tool call / CLI structured output).
//
// Backends, in order:
//   FOREMAN_LLM_STUB=<module.mjs>  test seam: default export (args) => object
//   ANTHROPIC_API_KEY              Anthropic Messages API, forced tool call
//   otherwise                      local Claude Code CLI (`claude -p --json-schema`)
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const API_MODEL = () => process.env.FOREMAN_MODEL || 'claude-sonnet-5-5';
const CLI_MODEL = () => process.env.FOREMAN_CLI_MODEL || 'sonnet';
const CLI_TIMEOUT_MS = 300_000;

/** Name of the model used for the current backend (recorded in plans and decision records). */
export function modelName() {
  if (process.env.FOREMAN_LLM_STUB) return 'stub';
  return process.env.ANTHROPIC_API_KEY ? API_MODEL() : `claude-cli:${CLI_MODEL()}`;
}

export async function askJSON({ system = '', prompt, schema, model }) {
  if (process.env.FOREMAN_LLM_STUB) {
    const mod = await import(pathToFileURL(resolve(process.env.FOREMAN_LLM_STUB)).href);
    return mod.default({ system, prompt, schema, model });
  }
  return process.env.ANTHROPIC_API_KEY
    ? askAnthropic({ system, prompt, schema, model })
    : askCli({ system, prompt, schema, model });
}

async function askAnthropic({ system, prompt, schema, model }) {
  const res = await fetch(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || API_MODEL(),
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ name: 'respond', description: 'Return the answer in the required structure.', input_schema: schema }],
      tool_choice: { type: 'tool', name: 'respond' },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${body?.error?.message || 'request failed'}`);
  const block = (body.content || []).find((b) => b.type === 'tool_use');
  if (!block) throw new Error('Anthropic API returned no structured answer');
  return block.input;
}

function askCli({ system, prompt, schema, model }) {
  // Strip the variables that make a nested `claude` think it runs inside another Claude Code session.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE' && !k.startsWith('CLAUDE_CODE')),
  );
  const args = [
    '-p', system ? `${system}\n\n${prompt}` : prompt,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--model', model || CLI_MODEL(),
    '--tools', '', // pure reasoning: the agent's tools are the paid ones Foreman calls itself
    '--no-session-persistence',
    '--setting-sources', 'project', // ignore the operator's personal CLAUDE.md/hooks: the agent must behave the same on any machine
  ];
  return new Promise((ok, fail) => {
    const child = spawn('claude', args, { cwd: '/tmp', env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error(`claude CLI timed out after ${CLI_TIMEOUT_MS / 1000}s`)); }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); fail(new Error(`cannot run claude CLI: ${e.message}. Set ANTHROPIC_API_KEY or install Claude Code.`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed;
      try { parsed = JSON.parse(out); } catch { /* handled below */ }
      if (parsed?.structured_output && typeof parsed.structured_output === 'object') return ok(parsed.structured_output);
      const why = parsed?.result || parsed?.subtype || err.trim() || out.trim();
      fail(new Error(`claude CLI exit ${code}, no structured output: ${String(why).slice(0, 300)}`));
    });
  });
}
