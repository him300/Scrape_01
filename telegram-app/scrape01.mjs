// scrape01 — a Telegram view/controller over the Scrape_01 CLI.
//
// The CLI is the authoritative owner; this app only projects it and calls it
// with exact argument vectors. No shell, no arbitrary commands: every method
// below maps to one fixed `scrape01` invocation.
//
// The monster toggle lives here, in app state, so it survives between taps and
// applies to every subsequent action.

import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

const APP = 'scrape01';
const DEFAULT_ROOT = 'C:/Users/vande/Desktop/Pi Agent/Scrape_01';
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

const nowIso = () => new Date().toISOString();

function btn(label, prompt) {
  return `{${label}|${prompt}}`;
}

function profileLine(state) {
  return state.monster
    ? '🧟 **monster** — robots.txt ignored, JavaScript rendered, 150 ms delay, 6 retries'
    : '🧹 **polite** — robots.txt obeyed, no JavaScript, 1 s delay, 3 retries';
}

function errorText(err) {
  return String(err?.message || err || 'unknown error').slice(0, 300);
}

async function datasetNames(root) {
  try {
    const files = await readdir(path.join(root, 'datasets'));
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

async function tailLog(root, file, lines = 12) {
  try {
    const text = await readFile(file, 'utf8');
    return text.split('\n').filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '(no log yet)';
  }
}

// ---------------------------------------------------------------- helpers

function scrapeArgv(root, args) {
  return [path.join(root, 'bin', 'scrape01.mjs'), ...args];
}

// Long jobs (a create that calls pi, a crawl of many pages) run detached and
// write to a log file; the app never blocks a Telegram tap on them.
async function startBackground(root, label, args, logDir) {
  await mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, `${label}.log`);
  await appendFile(logFile, `\n=== ${nowIso()} scrape01 ${args.join(' ')} ===\n`, 'utf8');
  const out = await openAppend(logFile);
  const child = spawn(process.execPath, scrapeArgv(root, args), {
    cwd: root,
    detached: true,
    stdio: ['ignore', out.fd, out.fd],
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid, logFile, startedAt: nowIso(), args };
}

async function openAppend(file) {
  const { open } = await import('node:fs/promises');
  return open(file, 'a');
}

async function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ views

async function homeView(state, { run, statusText = null } = {}) {
  const root = state.root;
  const names = await datasetNames(root);
  let status = statusText;
  if (status === null) {
    try {
      const res = await run({ command: process.execPath, args: scrapeArgv(root, ['status']), cwd: root, timeoutMs: 20000 });
      status = (res.stdout || res.stderr || '(no output)').trim();
    } catch (err) {
      status = `status failed: ${errorText(err)}`;
    }
  }
  const job = state.job;
  const jobLine = job ? `\n**Running:** \`${job.args.join(' ')}\` (pid ${job.pid})\n\`${job.logFile}\`` : '';

  return {
    output: `**Scrape_01** — \`${root}\`

${profileLine(state)}

Datasets: ${names.length ? names.map((n) => `\`${n}\``).join(' ') : 'none yet'}${jobLine}

\`\`\`
${status.slice(0, 1600)}
\`\`\`

\`\`\`telegram_button
[${btn('📊 Status', `${APP}::status`)}${btn(state.monster ? '🧹 Go polite' : '🧟 Go monster', `${APP}::toggle`)}]
[${btn('📜 Logs', `${APP}::logs`)}${btn('▶️ Run all', `${APP}::runall`)}]
[${btn('🩺 Doctor', `${APP}::doctor`)}${btn('🆕 New scrape', 'I want a new Scrape_01 dataset. Ask me for the URL and what to extract, then create it with the scrape01 app using the current profile.')}]
]`,
  };
}

// ---------------------------------------------------------------- methods

export async function init({ argument } = {}) {
  const rootArg = typeof argument?.root === 'string' ? argument.root : DEFAULT_ROOT;
  const root = rootArg.replace(/[\\/]+$/, '');
  return {
    state: {
      root,
      monster: argument?.monster === true,
      job: null,
      last: null,
    },
    output: `**Scrape_01** control surface ready.

Workspace: \`${root}\`

${profileLine({ monster: argument?.monster === true })}

\`\`\`telegram_button
[${btn('📊 Status', `${APP}::status`)}${btn('🧹 Go polite', `${APP}::toggle`)}]
[${btn('📜 Logs', `${APP}::logs`)}${btn('▶️ Run all', `${APP}::runall`)}]
[${btn('🩺 Doctor', `${APP}::doctor`)}${btn('🆕 New scrape', 'I want a new Scrape_01 dataset. Ask me for the URL and what to extract, then create it with the scrape01 app using the current profile.')}]
]`,
  };
}

export async function status({ state, run }) {
  return { output: (await homeView(state, { run })).output };
}

export async function refresh({ state, run }) {
  const view = await homeView(state, { run });
  const running = state.job && (await isAlive(state.job.pid));
  return { output: view.output, ...(running ? { refreshAfterMs: 10000 } : {}) };
}

export async function toggle({ state }) {
  const next = { ...state, monster: !state.monster };
  const view = await homeView(next, { statusText: '(profile switched)' });
  return { state: next, output: view.output };
}

export async function doctor({ state, run }) {
  try {
    const res = await run({ command: process.execPath, args: scrapeArgv(state.root, ['doctor']), cwd: state.root, timeoutMs: 45000 });
    return { output: `**doctor**\n\`\`\`\n${(res.stdout || res.stderr || '').trim().slice(0, 2200)}\n\`\`\`` };
  } catch (err) {
    return { output: `**doctor failed:** ${errorText(err)}` };
  }
}

export async function logs({ state }) {
  const logDir = path.join(state.root, '.scrape01', 'telegram');
  const files = state.job?.logFile ? [state.job.logFile] : [];
  const day = new Date().toISOString().slice(0, 10);
  const runLog = path.join(state.root, '.scrape01', 'logs', `run-${day}.jsonl`);
  let text;
  if (files.length) {
    text = await tailLog(files[0], 16);
  } else {
    const raw = await tailLog(runLog, 16);
    text = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          const e = JSON.parse(l);
          return `${e.time ? e.time.slice(11, 19) : ''} ${e.level || 'info'} ${e.msg || ''}${e.error ? ` — ${e.error}` : ''}`;
        } catch {
          return l;
        }
      })
      .join('\n');
  }
  return {
    output: `**logs**${state.job ? ` — ${state.job.args.join(' ')}` : ''}\n\`\`\`\n${text.slice(0, 2200)}\n\`\`\`\n\n\`\`\`telegram_button\n[${btn('📊 Status', `${APP}::status`)}${btn('📜 Refresh logs', `${APP}::logs`)}]\n]`,
  };
}

export async function runall({ state }) {
  if (state.job && (await isAlive(state.job.pid))) {
    return { output: `**Already running:** \`${state.job.args.join(' ')}\` (pid ${state.job.pid}).\n\n\`\`\`telegram_button\n[${btn('📜 Logs', `${APP}::logs`)}${btn('⏹ Stop', `${APP}::stop`)}]\n]` };
  }
  const args = ['run', '--all'];
  if (state.monster) args.push('--monster');
  const job = await startBackground(state.root, 'run-all', args, path.join(state.root, '.scrape01', 'telegram'));
  const next = { ...state, job };
  return {
    state: next,
    output: `**Started:** \`scrape01 ${args.join(' ')}\`\n\n${profileLine(state)}\n\n\`\`\`telegram_button\n[${btn('📜 Logs', `${APP}::logs`)}${btn('⏹ Stop', `${APP}::stop`)}]\n]`,
  };
}

export async function runone({ state, argument }) {
  const name = argString(argument, 'dataset');
  if (!NAME_RE.test(name)) return { output: `**Bad dataset name.** Use lowercase letters, digits, \`_\` or \`-\`.` };
  const names = await datasetNames(state.root);
  if (!names.includes(name)) return { output: `**Unknown dataset "${name}".** Known: ${names.join(', ') || 'none'}` };
  const args = ['run', name];
  if (state.monster) args.push('--monster');
  const job = await startBackground(state.root, `run-${name}`, args, path.join(state.root, '.scrape01', 'telegram'));
  const next = { ...state, job };
  return {
    state: next,
    output: `**Started:** \`scrape01 ${args.join(' ')}\`\n\n${profileLine(state)}\n\n\`\`\`telegram_button\n[${btn('📜 Logs', `${APP}::logs`)}${btn('⏹ Stop', `${APP}::stop`)}]\n]`,
  };
}

export async function create({ state, argument }) {
  const url = argString(argument, 'url');
  const goal = argString(argument, 'goal');
  const name = argString(argument, 'name') || deriveName(url);
  if (!/^https?:\/\//i.test(url)) return { output: `**Need an absolute http(s) URL.**` };
  if (!NAME_RE.test(name)) return { output: `**Bad dataset name.** Use lowercase letters, digits, \`_\` or \`-\`.` };
  if (state.job && (await isAlive(state.job.pid))) {
    return { output: `**Busy:** \`${state.job.args.join(' ')}\` is still running. Stop it first.` };
  }
  const monster = argument?.monster === undefined ? state.monster : argument.monster === true;
  const args = ['new', name, '--url', url];
  if (goal) args.push('--goal', goal);
  if (monster) args.push('--monster');
  const job = await startBackground(state.root, `new-${name}`, args, path.join(state.root, '.scrape01', 'telegram'));
  const next = { ...state, job, last: { name, url, goal, monster } };
  return {
    state: next,
    output: `**Started:** \`scrape01 ${args.join(' ')}\`\n\n${monster ? '🧟 monster' : '🧹 polite'} — this calls pi several times (plan → re-plan → verify → repair → goal check), so it takes a few minutes.\n\n\`\`\`telegram_button\n[${btn('📜 Logs', `${APP}::logs`)}${btn('⏹ Stop', `${APP}::stop`)}]\n]`,
  };
}

export async function stop({ state }) {
  if (!state.job) return { output: `**Nothing is running.**` };
  const pid = state.job.pid;
  let stopped = false;
  try {
    process.kill(pid, 'SIGTERM');
    stopped = true;
  } catch {
    stopped = false;
  }
  const next = { ...state, job: null };
  return {
    state: next,
    output: `**${stopped ? 'Stopped' : 'Could not stop'}** pid ${pid}.${stopped ? '' : ' It may have already finished.'}\n\n\`\`\`telegram_button\n[${btn('📊 Status', `${APP}::status`)}${btn('📜 Logs', `${APP}::logs`)}]\n]`,
  };
}

export async function csv({ state, run, argument }) {
  const name = argString(argument, 'dataset');
  if (!NAME_RE.test(name)) return { output: `**Bad dataset name.**` };
  try {
    const res = await run({ command: process.execPath, args: scrapeArgv(state.root, ['csv', name, '--limit', '12']), cwd: state.root, timeoutMs: 20000 });
    return { output: `**${name}**\n\`\`\`\n${(res.stdout || res.stderr || '').trim().slice(0, 2200)}\n\`\`\`` };
  } catch (err) {
    return { output: `**csv failed:** ${errorText(err)}` };
  }
}

export async function inspect({ state }) {
  return { output: JSON.stringify(state, null, 2) };
}

// The runtime delivers a bound argument as a strict JSON value; accept the
// shapes that can show up (plain string, {field: value}) without guessing.
function argString(argument, field) {
  if (argument == null) return '';
  if (typeof argument === 'string') return argument.trim();
  if (typeof argument !== 'object') return '';
  const v = argument[field];
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) if (typeof v[k] === 'string') return v[k].trim();
  }
  return '';
}

function deriveName(url) {
  try {
    const u = new URL(url);
    return (u.hostname + '-' + (u.pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root'))
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  } catch {
    return 'dataset';
  }
}
