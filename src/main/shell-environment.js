/**
 * Recover the user's login-shell PATH for a packaged launch.
 *
 * An app opened from Finder or the Dock inherits launchd's environment, whose
 * PATH is `/usr/bin:/bin:/usr/sbin:/sbin`. Agent tools would then find neither
 * Homebrew, nor git from Xcode's toolchain shims, nor anything under
 * `~/.cargo`, `~/.local/bin`, nvm, mise, and so on. `pnpm start` from a terminal
 * does not have the problem, so this runs only for the packaged app.
 *
 * The user's shell runs once as an interactive login shell and prints its
 * environment between random markers (startup files may print anything).
 * Only PATH and a short list of toolchain variables are adopted — a shell's
 * complete exported environment is not an appropriate ambient input, and
 * secrets in it would otherwise reach every agent subprocess. PATH replaces
 * the inherited value; the other keys never override one already set.
 *
 * Follows the approach of `dsh-plugin-desktop/src/shell-environment.ts`.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { basename, isAbsolute } from 'node:path';

/** Hard deadline for the shell; a slow rc file must not stall startup. */
const CAPTURE_TIMEOUT_MS = 3_000;

/** Largest accepted capture. */
const MAX_CAPTURE_BYTES = 1024 * 1024;

/** Shells known to accept these flags, keyed by basename. */
const SHELL_ARGUMENTS = new Map([
  ['bash', ['-ilc']],
  ['zsh', ['-ilc']],
  ['fish', ['--login', '--interactive', '--command']],
]);

/** Variables adopted in addition to PATH, when not already set. */
export const ADOPTED_KEYS = new Set([
  'ANDROID_HOME', 'ASDF_DATA_DIR', 'ASDF_DIR', 'BUN_INSTALL', 'CARGO_HOME',
  'DENO_INSTALL', 'GOPATH', 'GOROOT', 'HOMEBREW_CELLAR', 'HOMEBREW_PREFIX',
  'HOMEBREW_REPOSITORY', 'JAVA_HOME', 'LANG', 'MISE_DATA_DIR', 'NVM_BIN',
  'NVM_DIR', 'PNPM_HOME', 'PYENV_ROOT', 'RBENV_ROOT', 'RUSTUP_HOME',
  'SDKMAN_DIR', 'VOLTA_HOME',
]);

/**
 * Extract the environment printed between two markers.
 *
 * @param payload - captured stdout.
 * @param start - start marker.
 * @param end - end marker.
 * @returns the parsed environment.
 * @throws when a marker is missing or a record is malformed.
 */
export function parseCapture(payload, start, end) {
  const text = payload.toString('utf8');
  const from = text.indexOf(`${start}\0`);
  if (from < 0) throw new Error('shell environment: start marker missing');
  const bodyStart = from + start.length + 1;
  const to = text.indexOf(`${end}\0`, bodyStart);
  if (to < 0) throw new Error('shell environment: end marker missing');

  const environment = {};
  for (const record of text.slice(bodyStart, to).split('\0')) {
    if (record === '') continue;
    const separator = record.indexOf('=');
    if (separator <= 0) throw new Error('shell environment: malformed record');
    environment[record.slice(0, separator)] = record.slice(separator + 1);
  }
  return environment;
}

/**
 * Choose which captured values to adopt.
 *
 * @param captured - login-shell environment.
 * @param inherited - current process environment.
 * @returns the updates to apply.
 */
export function selectUpdates(captured, inherited) {
  const updates = {};
  for (const [name, value] of Object.entries(captured)) {
    if (typeof value !== 'string') continue;
    if (name === 'PATH') {
      if (value !== '') updates.PATH = value;
    } else if ((ADOPTED_KEYS.has(name) || name.startsWith('LC_')) && inherited[name] === undefined) {
      updates[name] = value;
    }
  }
  return updates;
}

/**
 * Run the login shell and capture its environment.
 *
 * @param shell - absolute shell path.
 * @param home - working directory for the shell.
 * @returns the captured environment.
 */
function capture(shell, home) {
  const flags = SHELL_ARGUMENTS.get(basename(shell));
  const nonce = randomBytes(16).toString('hex');
  const start = `dsh-desktop-env-start-${nonce}`;
  const end = `dsh-desktop-env-end-${nonce}`;
  const command = `/usr/bin/printf '%s\\0' '${start}'; /usr/bin/env -0; /usr/bin/printf '%s\\0' '${end}'`;

  return new Promise((resolve, reject) => {
    const child = spawn(shell, [...flags, command], {
      cwd: home,
      detached: true,
      env: { HOME: home, SHELL: shell, USER: process.env.USER ?? '', LOGNAME: process.env.LOGNAME ?? '', TERM: 'dumb', PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks = [];
    let size = 0;
    let failure;
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      failure = new Error('shell environment: timed out');
      kill();
    }, CAPTURE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_CAPTURE_BYTES) {
        failure = new Error('shell environment: output too large');
        kill();
        return;
      }
      chunks.push(chunk);
    });
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', () => {
      clearTimeout(timer);
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      try {
        resolve(parseCapture(Buffer.concat(chunks), start, end));
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * Adopt the login shell's PATH (and a few toolchain variables) into
 * `process.env`. Never throws: on any failure the inherited environment stays.
 *
 * @param options - `{ home, log }`.
 * @returns a short description of the outcome, for diagnostics.
 */
export async function adoptLoginShellEnvironment(options) {
  let shell;
  try {
    shell = userInfo().shell ?? undefined;
  } catch {
    // Fall back to the inherited SHELL below.
  }
  shell ||= process.env.SHELL;
  if (shell === undefined || !isAbsolute(shell) || !SHELL_ARGUMENTS.has(basename(shell))) {
    return `kept inherited environment (unsupported shell ${String(shell)})`;
  }

  try {
    const updates = selectUpdates(await capture(shell, options.home), process.env);
    if (updates.PATH === undefined) return 'kept inherited environment (shell reported no PATH)';
    Object.assign(process.env, updates);
    return `adopted ${Object.keys(updates).join(', ')} from ${shell}`;
  } catch (error) {
    return `kept inherited environment (${String(error?.message ?? error)})`;
  }
}
