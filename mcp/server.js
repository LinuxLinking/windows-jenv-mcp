#!/usr/bin/env node
/*
 * jenv-mcp - a read-only + controlled-execution MCP server for the `batch/`
 * implementation of JEnv for Windows.
 *
 * WHAT THIS IS
 *   JEnv for Windows switches between JDK installations by putting a fake `java.bat`
 *   early on PATH. That design assumes a human types `java` and lets PATH intercept it.
 *   AI agents do not work that way: they write absolute paths, or they "helpfully" edit
 *   PATH / JAVA_HOME to make a build succeed, which corrupts the user's carefully
 *   maintained JDK selection. This server replaces "the agent guesses" with "the agent
 *   asks", and offers one controlled-execution tool that injects JAVA_HOME for a single
 *   child process only.
 *
 * CONTRACT (do not weaken these)
 *   1. This server never writes anything. It does not create the registry directory,
 *      does not touch the registry files, does not modify any environment variable of
 *      its own process (spawned children get a copy), and never invokes
 *      `jenv use` / `change` / `local` / `add` / `remove` / `uninstall` / `link`.
 *      `batch/jenv-change.bat` runs `setx JAVA_HOME /M` (machine scope, needs admin) and
 *      `batch/jenv-use.bat` leaks JENVUSE into the caller's session. Neither is reachable
 *      from here.
 *   2. stdout carries MCP messages and nothing else. Ever. Logging goes to stderr.
 *   3. Spawned children get `stdio: ['ignore', 'pipe', 'pipe']`. A child that inherits
 *      our stdin will eat MCP frames and the server will appear to die at random.
 *
 * Zero dependencies: node:fs, node:path, node:child_process, node:readline only.
 * Protocol: MCP over stdio, newline-delimited JSON-RPC 2.0 (no Content-Length headers).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVER_NAME = 'jenv-mcp';
const SERVER_VERSION = '0.1.0';

const SUPPORTED_PROTOCOLS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
];
const LATEST_PROTOCOL = '2025-11-25';

const MAX_LINE_CHARS = 8 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 120000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 600000;

const DEFAULT_MAX_OUTPUT = 1024 * 1024;
const MIN_MAX_OUTPUT = 4096;
const MAX_MAX_OUTPUT = 8 * 1024 * 1024;

const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const MAX_RELEASE_BYTES = 8 * 1024;

// Characters that cmd.exe re-interprets even when an argument arrived as a separate
// argv element. Verified empirically: `spawn(cmd, ['/d','/v:off','/s','/c','echo','&','echo','X'])`
// prints two lines, and `echo %USERNAME%` expands. Only enforced for .cmd/.bat targets.
const CMD_METACHARS = /[&|<>^%!"()\r\n]/;
const CRLF = /[\r\n]/;

// The same risk applies to the TARGET PATH of a .cmd/.bat, which is concatenated into the
// `cmd.exe /c` command line - and it was unguarded, so a registry entry like
// `java17=E:\JDK&calc` made every .cmd launch run `calc`. Deliberately narrower than
// CMD_METACHARS: a space and parentheses are LEGAL in a Windows path
// (`C:\Program Files (x86)`) and are neutralised by the quoting in buildCmdPayload().
const CMD_TARGET_METACHARS = /[&|<>^%!"]/;

const EXE_EXTS = ['.exe', '.cmd', '.bat', '.com'];

// Only JENVUSE is honoured as a tier-1 override from the environment. It is normally
// absent because MCP clients spawn servers with a narrow env whitelist, which is exactly
// why jenv_current / jenv_run also take an explicit `use` parameter.
const ENV_USE = 'JENVUSE';

const RUNTIME_DISABLED = process.env.JENV_MCP_DISABLE_RUN === '1';
const FORCED_ENCODING = process.env.JENV_MCP_ENCODING || null;

const INSTRUCTIONS = [
  'JEnv for Windows registry tools. The registry lives in %APPDATA%\\JEnv:',
  'jenvs.txt (name=path JDK list), locals.txt (name=dir directory bindings),',
  'global.txt (one JAVA_HOME path). Resolution order is a `use`/JENVUSE override, then a',
  'local binding whose directory exactly equals the working directory (case-insensitive;',
  'there is NO subfolder inheritance), then the global default. Call jenv_list to see what',
  'is registered and jenv_current to learn which JDK applies to a directory and why - its',
  'trace shows every tier that was checked. This server is read-only: it can never change',
  'JAVA_HOME, PATH, or the registry. To build or run with a specific JDK use jenv_run',
  'rather than exporting JAVA_HOME yourself; it sets JAVA_HOME, JENVUSE and prepends',
  '<JDK>\\bin to PATH for that child only. Gradle needs JAVA_HOME (jenv_run supplies it);',
  'Maven does not. Never call `jenv use` or `jenv change`. If the registry is empty, ask',
  'the user to run `jenv add <name> <path>` and `jenv change <name>`.',
].join(' ');

// ---------------------------------------------------------------------------
// Logging - stderr only
// ---------------------------------------------------------------------------

function log(message) {
  try {
    process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
  } catch {
    /* stderr is gone; nothing sensible left to do */
  }
}

// A future edit that reaches for console.log must not be able to corrupt stdout.
console.log = (...args) => log(args.join(' '));
console.info = (...args) => log(args.join(' '));
console.warn = (...args) => log(args.join(' '));

// ---------------------------------------------------------------------------
// Encoding
//
// The registry files are written by cmd's `echo`, so they are encoded in the console
// codepage (CP936 / GBK on Chinese Windows), not UTF-8. Node has no `gbk` Buffer
// encoding, but official Node builds ship full ICU, where TextDecoder supports legacy
// encodings. Decode UTF-8 strictly first (ASCII and genuine UTF-8 take this path), then
// fall back. Same helper is used for child process output.
// ---------------------------------------------------------------------------

let warnedNoGb = false;

function sniffBom(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf-8', skip: 3 };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: 'utf-16le', skip: 2 };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: 'utf-16be', skip: 2 };
  }
  return null;
}

function tryDecode(buf, encoding, fatal) {
  // Throws on unsupported encoding (small-ICU builds) or, when fatal, on bad bytes.
  return new TextDecoder(encoding, { fatal: Boolean(fatal) }).decode(buf);
}

/**
 * @returns {{text: string, encoding: string, warnings: string[]}}
 */
function decodeBuffer(buf) {
  const warnings = [];
  if (buf.length === 0) return { text: '', encoding: 'utf-8', warnings };

  if (FORCED_ENCODING) {
    try {
      const bom = sniffBom(buf);
      const skip = bom && bom.encoding === FORCED_ENCODING ? bom.skip : 0;
      return { text: tryDecode(buf.subarray(skip), FORCED_ENCODING, false), encoding: FORCED_ENCODING, warnings };
    } catch (err) {
      warnings.push(`JENV_MCP_ENCODING="${FORCED_ENCODING}" is not usable here (${err.message}); utf-8 was used instead.`);
    }
  }

  const bom = sniffBom(buf);
  if (bom) {
    try {
      return { text: tryDecode(buf.subarray(bom.skip), bom.encoding, true), encoding: bom.encoding, warnings };
    } catch (err) {
      warnings.push(`File starts with a ${bom.encoding} BOM but does not decode as ${bom.encoding}: ${err.message}`);
    }
  }

  try {
    return { text: tryDecode(buf, 'utf-8', true), encoding: 'utf-8', warnings };
  } catch {
    /* not UTF-8; fall through to the console codepage */
  }

  for (const enc of ['gb18030', 'gbk']) {
    try {
      const text = tryDecode(buf, enc, false);
      return { text, encoding: enc, warnings };
    } catch {
      /* try the next legacy encoding */
    }
  }

  if (!warnedNoGb) {
    warnedNoGb = true;
    log('this Node build has no GBK/GB18030 support (small-ICU); non-ASCII registry entries may be mojibake');
  }
  warnings.push(
    'GBK/GB18030 decoding is unavailable in this Node build (small-ICU build); ' +
      'non-ASCII names may be mojibake. Use ASCII registry names, or set JENV_MCP_ENCODING.'
  );
  return { text: tryDecode(buf, 'utf-8', false), encoding: 'utf-8', warnings };
}

function splitLines(text) {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function registryDir() {
  if (process.env.JENV_APPDATA) {
    return { dir: process.env.JENV_APPDATA, source: 'JENV_APPDATA' };
  }
  const appData = process.env.APPDATA || process.env.LOCALAPPDATA;
  if (appData) return { dir: path.join(appData, 'JEnv'), source: 'APPDATA' };
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) return { dir: path.join(home, 'AppData', 'Roaming', 'JEnv'), source: 'USERPROFILE' };
  return { dir: path.join(process.cwd(), 'JEnv'), source: 'missing' };
}

function readFileCapped(file, cap) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const warnings = [];
  let size = stat.size;
  let truncated = false;
  if (size > cap) {
    size = cap;
    truncated = true;
    warnings.push(`${path.basename(file)} is larger than ${cap} bytes; only the first ${cap} bytes were read.`);
  }
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    const read = fs.readSync(fd, buf, 0, size, 0);
    return { buf: buf.subarray(0, read), warnings, truncated };
  } catch (err) {
    return { buf: Buffer.alloc(0), warnings: [`${path.basename(file)} could not be read: ${err.message}`], truncated: false };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Mirror `for /f "usebackq tokens=1,* delims=="`: split on the FIRST `=` only, so values
 * may contain `=` while keys may not. No trimming - `delims==` does not treat space as a
 * delimiter, and "helpfully" trimming would make this server disagree with `jenv getjava`.
 */
function parseKvLine(line) {
  const eq = line.indexOf('=');
  if (eq === -1) return { key: line, value: '' };
  return { key: line.slice(0, eq), value: line.slice(eq + 1) };
}

/**
 * Shared line rules for `for /f`: empty lines are skipped, and the default `eol=;` skips
 * lines that START with a semicolon.
 */
function isSkippableLine(line) {
  return line === '' || line.charAt(0) === ';';
}

function readKvFile(file, label) {
  const warnings = [];
  const fileInfo = { path: file, exists: false, lines: 0 };
  const out = readFileCapped(file, MAX_REGISTRY_BYTES);
  if (out === null) return { entries: [], warnings, fileInfo };

  fileInfo.exists = true;
  warnings.push(...out.warnings);
  const decoded = decodeBuffer(out.buf);
  warnings.push(...decoded.warnings);

  const lines = splitLines(decoded.text);
  fileInfo.lines = lines.length;

  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isSkippableLine(line)) continue;
    const { key, value } = parseKvLine(line);
    if (key === '') {
      // cmd's `for /f` skips leading delimiters and would mis-parse `=foo` as key "foo".
      // That is nonsense data; ignore it rather than reproduce the mis-parse.
      warnings.push(`${label} line ${i + 1} starts with "="; ignored (the batch parser would mis-read this line).`);
      continue;
    }
    if (key.trim() !== key) {
      warnings.push(`${label} line ${i + 1} has leading/trailing whitespace in the name ("${key}"), which the batch parser keeps as-is.`);
    }
    entries.push({ key, value, line: i + 1 });
  }
  return { entries, warnings, fileInfo };
}

/**
 * `global.txt` is read with `delims=` - the whole line verbatim, no `=` splitting - and the
 * LAST non-empty line wins, because the batch loop assigns on every iteration.
 */
function readGlobalFile(file) {
  const warnings = [];
  const fileInfo = { path: file, exists: false, lines: 0 };
  const out = readFileCapped(file, MAX_REGISTRY_BYTES);
  if (out === null) return { value: null, warnings, fileInfo };

  fileInfo.exists = true;
  warnings.push(...out.warnings);
  const decoded = decodeBuffer(out.buf);
  warnings.push(...decoded.warnings);

  const lines = splitLines(decoded.text);
  fileInfo.lines = lines.length;

  let found = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isSkippableLine(line)) continue;
    found = { value: line, line: i + 1 };
  }
  return { value: found, warnings, fileInfo };
}

function parseRegistry(extraWarnings) {
  const reg = registryDir();
  const jenvsFile = path.join(reg.dir, 'jenvs.txt');
  const localsFile = path.join(reg.dir, 'locals.txt');
  const globalFile = path.join(reg.dir, 'global.txt');

  const jenvs = readKvFile(jenvsFile, 'jenvs.txt');
  const locals = readKvFile(localsFile, 'locals.txt');
  const global = readGlobalFile(globalFile);

  const warnings = [...extraWarnings, ...jenvs.warnings, ...locals.warnings, ...global.warnings];
  warnings.push(...duplicateWarnings(jenvs.entries, 'jenvs.txt'));
  warnings.push(...duplicateWarnings(locals.entries, 'locals.txt'));

  return {
    dir: reg.dir,
    dirSource: reg.source,
    jenvs: jenvs.entries,
    locals: locals.entries,
    global: global.value,
    files: { jenvs: jenvs.fileInfo, locals: locals.fileInfo, global: global.fileInfo },
    warnings,
  };
}

function duplicateWarnings(entries, label) {
  const warnings = [];
  const seen = new Map();
  for (const entry of entries) {
    const lc = entry.key.toLowerCase();
    if (seen.has(lc)) {
      warnings.push(`${label}: "${entry.key}" is defined more than once (lines ${seen.get(lc)} and ${entry.line}); the last one wins.`);
    }
    seen.set(lc, entry.line);
  }
  return warnings;
}

/** Last definition wins, matching the batch `for /f` loop's overwriting assignment. */
function findJenvPath(registry, name) {
  const lc = String(name).toLowerCase();
  let found = null;
  for (const entry of registry.jenvs) {
    if (entry.key.toLowerCase() === lc) found = entry;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Batch parity for the `local` tier. `jenv-getjava.bat` compares with a raw
 * `if /i "%%b"=="%CD%"`, so the registry value is taken VERBATIM - no trimming, no
 * trailing-separator stripping. Normalising it here would let this server resolve a
 * DIFFERENT JDK than the `java` on PATH would in that directory: for a hand-written
 * `java17=E:\work\` entry the batch falls through to global, while a normalising server
 * matches and reports a hit. Agreement with the batch is the entire point of this server.
 */
function registryDirKey(value) {
  return String(value).toLowerCase();
}

/**
 * The working directory side. `resolveJdk` runs `path.resolve` first, and that already
 * drops a trailing separator for every non-root path while PRESERVING it for a drive root
 * and a UNC share root - which is exactly what `%CD%` does. So the resolved value is
 * compared verbatim here; any extra normalisation would only ever diverge from the batch.
 */
function cwdDirKey(cwd) {
  return String(cwd).toLowerCase();
}

/**
 * A JAVA_HOME that is not absolute would make these RELATIVE paths, which statSync then
 * resolves against THIS SERVER's working directory - so a malformed registry entry (a bare
 * `java17` line) could silently appear to point at an unrelated java.exe. Such a JAVA_HOME
 * is unusable, so it yields null here and is reported as missing everywhere downstream.
 */
function javaExeIn(javaHome) {
  if (!javaHome || !path.isAbsolute(javaHome)) return null;
  return path.join(javaHome, 'bin', 'java.exe');
}

function binDirOf(javaHome) {
  if (!javaHome || !path.isAbsolute(javaHome)) return null;
  return path.join(javaHome, 'bin');
}

/** Read JAVA_HOME/release. Never spawns `java` - a "read" tool must not start processes. */
function readRelease(javaHome) {
  // Same reason as javaExeIn(): a relative JAVA_HOME would make this a RELATIVE path, stat'd
  // against the server's own cwd, so a `release` file sitting there would be reported as the
  // version of a JDK that is not even installed.
  if (!javaHome || !path.isAbsolute(javaHome)) return null;
  const file = path.join(javaHome, 'release');
  const out = readFileCapped(file, MAX_RELEASE_BYTES);
  if (out === null) return null;
  const decoded = decodeBuffer(out.buf);
  const m = decoded.text.match(/^JAVA_VERSION="([^"]+)"/m);
  return m ? m[1] : null;
}

function pathEntryList(pathValue) {
  return String(pathValue || '')
    .split(path.delimiter)
    .map((s) => s.replace(/^"|"$/g, '').trim())
    .filter(Boolean);
}

function looksLikePath(value) {
  return /[\\/]/.test(value);
}

// ---------------------------------------------------------------------------
// JDK resolution - mirrors batch/jenv-getjava.bat
//
//   1. use / JENVUSE   - treated as a literal JAVA_HOME path by the batch script; here the
//                        `use` parameter additionally accepts a registered name.
//   2. local           - locals.txt value EXACTLY equals the working directory
//                        (case-insensitive). No subfolder inheritance.
//   3. global          - last non-empty line of global.txt.
// ---------------------------------------------------------------------------

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

/**
 * Drop a trailing separator, but never at the cost of turning an absolute path into a
 * drive-relative one: `C:\` would become `C:`, which `path.isAbsolute` rejects and which
 * every downstream join would then resolve against the server's cwd.
 */
function stripTrailingSep(p) {
  const stripped = String(p).replace(/[\\/]+$/, '');
  return stripped === '' || !path.isAbsolute(stripped) ? String(p) : stripped;
}

function resolveJavaHomeFromUse(registry, use) {
  if (looksLikePath(use)) {
    if (!path.isAbsolute(use)) {
      throw new ToolError(
        'E_USE_NOT_ABSOLUTE',
        `The \`use\` value "${use}" looks like a path but is not absolute. ` +
          'Pass an absolute path like E:\\JDK_java\\jdk_17, or a registered name like java17.'
      );
    }
    const cleaned = stripTrailingSep(use);
    return { javaHome: cleaned, viaName: null };
  }
  const entry = findJenvPath(registry, use);
  if (!entry) {
    const names = registry.jenvs.map((e) => e.key);
    throw new ToolError(
      'E_NAME_NOT_FOUND',
      `No registered JDK named \`${use}\`. ` +
        (names.length ? `Registered names: ${names.join(', ')}. ` : 'The registry is empty. ') +
        'Run jenv_list to see the registry.'
    );
  }
  if (entry.value === '') {
    throw new ToolError(
      'E_NAME_EMPTY',
      `The registered JDK named \`${use}\` has an empty path in jenvs.txt line ${entry.line}. ` +
        `Fix it with \`jenv add ${use} <path>\`, or pass an absolute path as \`use\`.`
    );
  }
  return { javaHome: entry.value, viaName: entry.key };
}

/** The "nothing resolved" shape, shared by resolveJdk and by callers that must degrade. */
function unresolved(cwd, warnings, trace) {
  return {
    resolved: false,
    cwd,
    source: 'none',
    javaHome: null,
    javaExe: null,
    javaExeExists: false,
    release: null,
    matched: null,
    trace: trace || [],
    warnings: warnings || [],
  };
}

function resolveJdk(registry, options) {
  const cwdInput = options.cwd || process.cwd();
  const cwd = path.resolve(cwdInput);
  const trace = [];
  const warnings = [];

  if (options.cwd && !isUsableDirectory(cwd)) {
    throw new ToolError(
      'E_CWD_INVALID',
      `Working directory ${options.cwd} does not exist or is not a directory.`
    );
  }

  // Tier 1
  let useValue = null;
  let useOrigin = null;
  let useIsLiteralPath = false;
  if (typeof options.use === 'string' && options.use !== '') {
    useValue = options.use;
    useOrigin = 'use parameter';
  } else if (process.env[ENV_USE]) {
    useValue = process.env[ENV_USE];
    useOrigin = `environment variable ${ENV_USE}`;
    // `jenv-getjava.bat` echoes JENVUSE VERBATIM as JAVA_HOME - it is never treated as a
    // registry name. Only the explicit `use` parameter extends into name lookup, which is
    // what makes the tool usable at all given MCP clients spawn servers with a narrow env
    // whitelist. Without this split, a stale `JENVUSE=17` would silently resolve to a JDK
    // named `17` while `java` on PATH (which gets JAVA_HOME=17) would fail.
    useIsLiteralPath = true;
  }

  if (useValue !== null) {
    const r = useIsLiteralPath
      ? { javaHome: useValue, viaName: null }
      : resolveJavaHomeFromUse(registry, useValue);
    trace.push({
      tier: 'use',
      input: useValue,
      origin: useOrigin,
      result: 'hit',
      reason: useIsLiteralPath
        ? 'literal JAVA_HOME path (this is how `jenv getjava` reads JENVUSE)'
        : r.viaName
          ? `registered name "${r.viaName}"`
          : 'absolute path',
      value: r.javaHome,
    });
    return finish(registry, cwd, 'use', r.javaHome, trace, warnings, {
      file: null,
      key: r.viaName,
      value: useValue,
    });
  }
  trace.push({ tier: 'use', input: null, result: 'skip', reason: 'not set (no `use` parameter, no JENVUSE)' });

  // Tier 2
  const target = cwdDirKey(cwd);
  let localHit = null;
  let localChecked = 0;
  for (const entry of registry.locals) {
    localChecked++;
    if (registryDirKey(entry.value) === target) {
      localHit = entry; // last match wins, matching the batch loop
    }
  }
  if (localHit) {
    const jenv = findJenvPath(registry, localHit.key);
    // An entry that exists but carries an EMPTY path (`java17=` or a bare `java17` line)
    // must not count as a hit. The batch requires a non-empty path
    // (`if defined LPATH` / `if not "!LPATH!"==""`) and otherwise falls through to global.
    // Returning "" here would be worse than wrong: javaExeIn("") becomes the RELATIVE path
    // bin\java.exe, which gets stat'd against the server's own cwd and can silently "exist".
    if (jenv && jenv.value !== '') {
      trace.push({
        tier: 'local',
        input: cwd,
        result: 'hit',
        reason: `locals.txt line ${localHit.line}: ${localHit.key}=${localHit.value}`,
        value: jenv.value,
      });
      return finish(registry, cwd, 'local', jenv.value, trace, warnings, {
        file: 'locals.txt',
        line: localHit.line,
        key: localHit.key,
        value: localHit.value,
      });
    }
    if (jenv) {
      warnings.push(
        `locals.txt binds this directory to "${localHit.key}", but that name has an empty path in ` +
          `jenvs.txt line ${jenv.line}; falling back to the global default. Fix it with ` +
          `\`jenv add ${localHit.key} <path>\`.`
      );
      trace.push({
        tier: 'local',
        input: cwd,
        result: 'skip',
        reason:
          `locals.txt line ${localHit.line} names "${localHit.key}", whose jenvs.txt entry ` +
          `(line ${jenv.line}) has an empty path`,
      });
    } else {
      warnings.push(
        `locals.txt binds this directory to "${localHit.key}", but no such name exists in jenvs.txt. ` +
          'Run jenv_list to see the registry.'
      );
      trace.push({
        tier: 'local',
        input: cwd,
        result: 'skip',
        reason: `locals.txt line ${localHit.line} names "${localHit.key}", which is not in jenvs.txt`,
      });
    }
  } else {
    trace.push({
      tier: 'local',
      input: cwd,
      result: 'skip',
      reason: registry.files.locals.exists
        ? `no binding matched this exact directory (${localChecked} checked)`
        : 'locals.txt not found (0 bindings)',
    });
  }

  // Tier 3
  if (registry.global) {
    trace.push({
      tier: 'global',
      input: 'global.txt',
      result: 'hit',
      reason: `global.txt line ${registry.global.line}`,
      value: registry.global.value,
    });
    return finish(registry, cwd, 'global', registry.global.value, trace, warnings, {
      file: 'global.txt',
      line: registry.global.line,
      key: null,
      value: registry.global.value,
    });
  }
  trace.push({
    tier: 'global',
    input: 'global.txt',
    result: 'skip',
    reason: registry.files.global.exists ? 'global.txt has no non-empty line' : 'global.txt not found',
  });

  return unresolved(cwd, warnings, trace);
}

function finish(registry, cwd, source, javaHome, trace, warnings, matched) {
  const javaExe = javaExeIn(javaHome);
  let javaExeExists = false;
  if (javaExe !== null) {
    try {
      javaExeExists = fs.statSync(javaExe).isFile();
    } catch {
      javaExeExists = false;
    }
  }
  if (javaExe === null) {
    warnings.push(
      `Resolved JAVA_HOME "${javaHome}" is empty or not an absolute path, so no java.exe can be ` +
        'located from it. This is a malformed registry entry - fix it with `jenv add <name> <path>`.'
    );
  } else if (!javaExeExists) {
    warnings.push(
      `Resolved JAVA_HOME ${javaHome} has no bin\\java.exe. The registry entry looks stale.`
    );
  }
  return {
    resolved: true,
    cwd,
    source,
    javaHome,
    javaExe,
    javaExeExists,
    release: javaExeExists ? readRelease(javaHome) : null,
    matched,
    trace,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Command resolution
//
// Never select an extensionless candidate. On this machine `mvn` and `gradle` are
// extensionless POSIX shell scripts that appear on PATH BEFORE their .cmd siblings, and
// CreateProcess cannot run them. Extension order follows Windows precedence.
// ---------------------------------------------------------------------------

function resolveExecutable(command, binDir, pathValue, cwd) {
  const probe = (candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  };

  const kindOf = (file) => {
    const ext = path.extname(file).toLowerCase();
    return ext === '.cmd' || ext === '.bat' ? 'cmd' : 'exe';
  };

  const hasKnownExt = (name) => EXE_EXTS.some((ext) => name.toLowerCase().endsWith(ext));

  // A command that is or contains a path is used directly; it is never looked up on PATH,
  // and it is never joined onto a search directory (path.join does not reset on an
  // absolute second segment, which would silently build a nonexistent path).
  if (path.isAbsolute(command) || looksLikePath(command)) {
    const base = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    if (hasKnownExt(base)) {
      if (probe(base)) return { path: base, kind: kindOf(base) };
      throw new ToolError('E_CMD_NOT_FOUND', `\`${base}\` does not exist.`);
    }
    for (const ext of EXE_EXTS) {
      if (probe(base + ext)) return { path: base + ext, kind: kindOf(base + ext) };
    }
    if (probe(base)) {
      throw new ToolError(
        'E_CMD_EXTENSIONLESS',
        `Found \`${base}\`, but it has no executable extension (.exe/.cmd/.bat/.com). ` +
          'Windows cannot execute it - pass the path to the .exe/.cmd/.bat sibling instead.'
      );
    }
    throw new ToolError(
      'E_CMD_NOT_FOUND',
      `Cannot find \`${base}\` (tried ${EXE_EXTS.map((e) => base + e).join(', ')}).`
    );
  }

  // Bare name: <JAVA_HOME>\bin first, then every PATH entry, deduplicated. Extension order
  // follows Windows precedence; an extensionless candidate is never selected.
  const dirs = [];
  const seenDirs = new Set();
  for (const dir of [binDir, ...pathEntryList(pathValue)]) {
    const key = dir.toLowerCase();
    if (seenDirs.has(key)) continue;
    seenDirs.add(key);
    dirs.push(dir);
  }

  let extensionlessSeen = null;
  for (const dir of dirs) {
    for (const ext of EXE_EXTS) {
      const candidate = path.join(dir, command + ext);
      if (probe(candidate)) return { path: candidate, kind: kindOf(candidate) };
    }
    if (extensionlessSeen === null) {
      const bare = path.join(dir, command);
      if (probe(bare)) extensionlessSeen = bare;
    }
  }

  if (extensionlessSeen) {
    throw new ToolError(
      'E_CMD_EXTENSIONLESS',
      `Found \`${extensionlessSeen}\`, but it has no executable extension (.exe/.cmd/.bat/.com), ` +
        `so Windows cannot execute it. Use the name \`${command}\` so a .cmd sibling is found, ` +
        'or pass the absolute path to the executable you actually mean.'
    );
  }

  throw new ToolError(
    'E_CMD_NOT_FOUND',
    `Cannot find \`${command}\`. Searched ${summarizeDirs(dirs)} for ` +
      `${EXE_EXTS.map((e) => command + e).join(', ')}. ` +
      'Extensionless files are skipped because Windows cannot execute them.'
  );
}

function summarizeDirs(dirs) {
  const unique = [...new Set(dirs)];
  const shown = unique.slice(0, 8);
  const suffix = unique.length > shown.length ? ` and ${unique.length - shown.length} more PATH entries` : '';
  return shown.join(', ') + suffix;
}

/** True only for a path that exists AND is a directory - a file is not a usable cwd. */
function isUsableDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function validateCmdArgument(value, targetPath, label) {
  const s = String(value);
  if (CMD_METACHARS.test(s)) {
    const hit = s.match(CMD_METACHARS)[0];
    const shown = hit === '\r' ? 'CR' : hit === '\n' ? 'LF' : hit;
    throw new ToolError(
      'E_ARG_METACHAR',
      `Refusing to run ${targetPath} with ${label} "${s}": the target is a .cmd/.bat file, so it runs ` +
        `through cmd.exe, where \`${shown}\` is interpreted rather than passed through literally. ` +
        'Arguments for .cmd/.bat targets must not contain any of: & | < > ^ % ! " ( ) or CR/LF. ' +
        'Flags such as -Dkey=value, -x, --project-dir and plain paths are fine.'
    );
  }
}

/**
 * The target path lands in the same `cmd.exe /c` command line as the arguments, so it needs
 * the same guard - checking only the arguments left a trivial injection: a registry entry
 * of `java17=E:\JDK&calc` made every .cmd launch under that JDK execute `calc`, because
 * cmd.exe split the path on `&` and ran both halves.
 */
function validateCmdTarget(targetPath) {
  const s = String(targetPath);
  const hit = (s.match(CMD_TARGET_METACHARS) || s.match(CRLF) || [null])[0];
  if (hit === null) return;
  const shown = hit === '\r' ? 'CR' : hit === '\n' ? 'LF' : hit;
  throw new ToolError(
    'E_PATH_METACHAR',
    `Refusing to run ${targetPath}: the target is a .cmd/.bat file, so its path is concatenated into a ` +
      `cmd.exe command line, where \`${shown}\` would be interpreted instead of treated as part of the path. ` +
      'Reinstall the tool somewhere without these characters, or point `use` at a JDK whose bin\\ path is clean.'
  );
}

/**
 * Build the `/c` payload for a .cmd/.bat target.
 *
 * With `/s`, cmd.exe treats everything between the FIRST and LAST quote of the whole payload
 * as the literal command line, which is why the outer pair of quotes below is mandatory.
 * Passing the pieces as separate argv elements does NOT work: Node only quotes argv elements
 * that contain a space, so the legacy cmd quote rule then strips the wrong quotes. Verified:
 * a target under `C:\Program Files\...` was truncated at the first space ("'C:\Program' is not
 * recognized") as soon as ONE argument contained a space.
 *
 * Every token here has already been cleared of the refused metacharacters - CMD_METACHARS for
 * arguments (which also rejects `"`) and CMD_TARGET_METACHARS for the path - so plain
 * double-quoting is unambiguous and there is no embedded quote left to escape.
 */
function buildCmdPayload(targetPath, args) {
  const quote = (s) => `"${s}"`;
  return `"${[targetPath, ...args].map(quote).join(' ')}"`;
}

// ---------------------------------------------------------------------------
// jenv_run
// ---------------------------------------------------------------------------

const liveChildren = new Set();

function killTree(pid) {
  if (!pid) return;
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
  try {
    spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  } catch {
    /* best effort */
  }
}

function killAllChildren() {
  for (const pid of liveChildren) killTree(pid);
  liveChildren.clear();
}

function clamp(value, min, max, fallback) {
  // An MCP client (often a model) can easily send "5000" as a string; the inputSchema says
  // integer but nothing enforces it server-side. Coerce numeric strings rather than silently
  // discarding them, and keep the old fallback for genuinely unusable values.
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function runCommand(params, registry) {
  const command = params.command;
  if (typeof command !== 'string' || command.trim() === '') {
    throw new ToolError('E_PARAMS', '`command` is required and must be a non-empty string.');
  }

  const args = params.args === undefined ? [] : params.args;
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new ToolError('E_PARAMS', '`args` must be an array of strings.');
  }

  const cwd = path.resolve(typeof params.cwd === 'string' && params.cwd ? params.cwd : process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new ToolError('E_CWD_INVALID', `Working directory ${cwd} does not exist or is not a directory.`);
  }

  const timeoutMs = clamp(params.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxOutputBytes = clamp(params.maxOutputBytes, MIN_MAX_OUTPUT, MAX_MAX_OUTPUT, DEFAULT_MAX_OUTPUT);

  const extraEnv = {};
  if (params.env !== undefined) {
    if (typeof params.env !== 'object' || params.env === null || Array.isArray(params.env)) {
      throw new ToolError('E_PARAMS', '`env` must be an object mapping variable names to strings.');
    }
    for (const [k, v] of Object.entries(params.env)) {
      if (typeof v !== 'string') throw new ToolError('E_PARAMS', `\`env.${k}\` must be a string.`);
      // extraEnv is spread LAST into the child environment, so an override here would replace
      // the cmd.exe this server chose as the launcher for .cmd/.bat targets - and that value
      // never goes through validateCmdTarget. The launcher stays server-chosen.
      if (k.toLowerCase() === 'comspec') {
        throw new ToolError(
          'E_ENV_RESERVED',
          '`env.ComSpec` cannot be overridden: it selects the cmd.exe this server launches ' +
            '.cmd/.bat targets with, which is deliberately chosen here rather than by the caller.'
        );
      }
      extraEnv[k] = v;
    }
  }

  const resolution = resolveJdk(registry, { cwd, use: params.use });
  if (!resolution.resolved) {
    throw new ToolError('E_NO_JDK', noJdkMessage(resolution));
  }
  if (!resolution.javaExeExists) {
    throw new ToolError(
      'E_PATH_MISSING',
      `JAVA_HOME for this directory is ${resolution.javaHome}, but ${resolution.javaExe || '<unusable JAVA_HOME>'} does not exist. ` +
        'The registry entry is stale - fix it with `jenv add <name> <correct path>`, or target a JDK directly with `use`.'
    );
  }

  const javaHome = resolution.javaHome;
  const binDir = binDirOf(javaHome);
  const resolved = resolveExecutable(command, binDir, process.env.PATH, cwd);

  if (resolved.kind === 'cmd') {
    validateCmdTarget(resolved.path);
    for (const arg of args) validateCmdArgument(arg, resolved.path, 'argument');
    // Environment VALUES are not interpolated into the command line - they go into the
    // child's environment block - so cmd metacharacters are irrelevant there, and refusing
    // them would reject a legitimate `env.PATH` like "C:\Program Files (x86)\...". Only
    // CR/LF are genuinely unusable in an environment value.
    for (const [k, v] of Object.entries(extraEnv)) {
      if (/[\r\n\0]/.test(v)) {
        throw new ToolError(
          'E_ENV_VALUE',
          `Refusing to run ${resolved.path}: env.${k} contains a NUL, CR or LF, which cannot be ` +
            'represented in a Windows environment block.'
        );
      }
    }
  } else {
    for (const arg of args) {
      if (CRLF.test(arg)) {
        throw new ToolError('E_ARG_METACHAR', 'Arguments must not contain CR or LF characters.');
      }
    }
  }

  // Build a fresh environment object. process.env itself is never written to, which is what
  // makes concurrent calls safe and leaves nothing behind.
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const childEnv = {
    ...process.env,
    // Not on the MCP client's env whitelist, but mvn.cmd / gradle.bat use nested `call`.
    ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'),
    JAVA_HOME: javaHome,
    // Belt and braces: batch's own shim chain re-resolves from JENVUSE, not JAVA_HOME.
    [ENV_USE]: javaHome,
    PATH: binDir + path.delimiter + (process.env.PATH || ''),
    ...extraEnv,
  };

  let launchKind = resolved.kind;
  let spawnTarget = resolved.path;
  let spawnArgs = args;
  let verbatimArgs = false;
  let cmdLine = [resolved.path, ...args];

  if (resolved.kind === 'cmd') {
    spawnTarget = childEnv.ComSpec;
    // /d skips AutoRun commands, /v:off disables delayed expansion, and /s makes cmd.exe take
    // everything between the FIRST and LAST quote of the payload as the literal command line.
    // windowsVerbatimArguments stops Node from wrapping the payload in its own quoting rules,
    // which are POSIX-flavoured (backslash escapes) and are not what cmd.exe understands.
    // Side effect of the flag: argv[0] is passed unquoted too, so a SystemRoot containing a
    // space would leave %0 mangled inside the child. The image still starts (CreateProcess gets
    // it as lpApplicationName) and nothing here reads %0, so this is noted rather than worked
    // around.
    spawnArgs = ['/d', '/v:off', '/s', '/c', buildCmdPayload(resolved.path, args)];
    verbatimArgs = true;
    cmdLine = [spawnTarget, ...spawnArgs];
  }

  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(spawnTarget, spawnArgs, {
        cwd,
        env: childEnv,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: verbatimArgs,
        // A child that inherits our stdin would consume MCP frames.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve(runFailure(resolution, resolved, cmdLine, cwd, command, args, {
        code: 'E_SPAWN',
        message: `Windows refused to start \`${resolved.path}\`: ${err.message}`,
      }));
      return;
    }

    const pid = child.pid;
    liveChildren.add(pid);

    const stdout = { chunks: [], bytes: 0, dropped: 0 };
    const stderr = { chunks: [], bytes: 0, dropped: 0 };

    const collect = (sink) => (chunk) => {
      if (sink.bytes < maxOutputBytes) {
        const room = maxOutputBytes - sink.bytes;
        if (chunk.length <= room) {
          sink.chunks.push(chunk);
          sink.bytes += chunk.length;
        } else {
          sink.chunks.push(chunk.subarray(0, room));
          sink.bytes += room;
          sink.dropped += chunk.length - room;
        }
      } else {
        sink.dropped += chunk.length;
      }
    };
    // The streams stay flowing (never destroyed) so the child is never SIGPIPE'd and its
    // exit code keeps its real meaning.
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));

    let timedOut = false;
    let settled = false;
    let spawnError = null;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(pid);
    }, timeoutMs);

    child.on('error', (err) => {
      spawnError = err;
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveChildren.delete(pid);

      const durationMs = Date.now() - started;
      const outDecoded = decodeBuffer(Buffer.concat(stdout.chunks));
      const errDecoded = decodeBuffer(Buffer.concat(stderr.chunks));

      let outText = outDecoded.text;
      if (stdout.dropped > 0) outText += `\n...[truncated: ${stdout.dropped} bytes dropped]`;
      let errText = errDecoded.text;
      if (stderr.dropped > 0) errText += `\n...[truncated: ${stderr.dropped} bytes dropped]`;

      const encoding = outDecoded.encoding === errDecoded.encoding ? outDecoded.encoding : `${outDecoded.encoding}/${errDecoded.encoding}`;
      const warnings = [...resolution.warnings, ...outDecoded.warnings, ...errDecoded.warnings];

      if (spawnError) {
        resolve(runFailure(resolution, resolved, cmdLine, cwd, command, args, {
          code: 'E_SPAWN',
          message: spawnFailureMessage(resolved.path, spawnError),
        }));
        return;
      }

      const ok = !timedOut && code === 0;
      const header = formatRunHeader(command, resolved, cmdLine, cwd, resolution, {
        exitCode: code,
        signal,
        timedOut,
        durationMs,
      });

      const body = [
        header,
        '',
        `--- stdout (${stdout.bytes} bytes${stdout.dropped ? `, ${stdout.dropped} dropped` : ''}) ---`,
        outText,
        `--- stderr (${stderr.bytes} bytes${stderr.dropped ? `, ${stderr.dropped} dropped` : ''}) ---`,
        errText,
      ].join('\n');

      let text = body;
      if (timedOut) {
        text =
          `\`${command} ${args.join(' ')}\` did not finish within ${timeoutMs} ms and was killed ` +
          '(the whole process tree was terminated with taskkill /T /F). ' +
          `Lower the work, or raise timeoutMs up to ${MAX_TIMEOUT_MS}.\n\n${body}`;
      }

      resolve({
        text,
        isError: !ok,
        structuredContent: {
          command,
          resolvedPath: resolved.path,
          launchKind,
          cmdLine,
          cwd,
          javaHome: resolution.javaHome,
          javaHomeSource: resolution.source,
          exitCode: typeof code === 'number' ? code : null,
          signal: signal || null,
          timedOut,
          durationMs,
          stdout: outText,
          stderr: errText,
          stdoutBytes: stdout.bytes,
          stderrBytes: stderr.bytes,
          stdoutTruncated: stdout.dropped > 0,
          stderrTruncated: stderr.dropped > 0,
          encoding,
          warnings,
        },
      });
    });
  });
}

function spawnFailureMessage(target, err) {
  const code = err.code || '';
  const message = err.message || '';
  if (code === 'ENOENT') return `\`${target}\` does not exist.`;
  if (code === 'UNKNOWN' || /spawn UNKNOWN/i.test(message)) {
    return (
      `Windows refused to start \`${target}\`: not a valid Win32 application. ` +
      'The file exists but is not an executable image (or is the wrong architecture).'
    );
  }
  if (code === 'EINVAL') {
    return `Windows refused to start \`${target}\` (spawn EINVAL). .cmd/.bat files cannot be launched directly.`;
  }
  if (code === 'EACCES') return `Access denied starting \`${target}\`.`;
  return `Windows refused to start \`${target}\`: ${message || code || 'unknown error'}`;
}

function formatRunHeader(command, resolved, cmdLine, cwd, resolution, status) {
  const lines = [];
  lines.push(`${command} (${resolved.path}${resolved.kind === 'cmd' ? ' via cmd.exe' : ''})`);
  lines.push(`cwd:        ${cwd}`);
  lines.push(`JAVA_HOME:  ${resolution.javaHome}   (source: ${resolution.source})`);
  if (status.timedOut) {
    lines.push(`result:     TIMED OUT after ${status.durationMs} ms`);
  } else if (status.exitCode === null || status.exitCode === undefined) {
    lines.push(`result:     killed by signal ${status.signal}`);
  } else {
    lines.push(`exit code:  ${status.exitCode}`);
  }
  lines.push(`duration:   ${status.durationMs} ms`);
  return lines.join('\n');
}

function runFailure(resolution, resolved, cmdLine, cwd, command, args, err) {
  return {
    text: err.message,
    isError: true,
    structuredContent: {
      command,
      resolvedPath: resolved.path,
      launchKind: resolved.kind,
      cmdLine,
      cwd,
      javaHome: resolution.javaHome,
      javaHomeSource: resolution.source,
      error: err.code,
      exitCode: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      warnings: resolution.warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Text rendering
// ---------------------------------------------------------------------------

function noJdkMessage(resolution) {
  return [
    `No JDK could be resolved for ${resolution.cwd}.`,
    '',
    'trace:',
    ...traceLines(resolution.trace),
    '',
    'The JEnv registry is empty or has no default. Register a JDK with:',
    '  jenv add java17 E:\\JDK_java\\jdk_17     (run in cmd, not through this server)',
    '  jenv change java17                     (sets the global default)',
    'Or call this tool with use="java17" / use="E:\\JDK_java\\jdk_17" to target a JDK directly.',
  ].join('\n');
}

function traceLines(trace) {
  return trace.map((t, i) => {
    const input = t.input ? `${t.input}` : '(none)';
    const value = t.value ? ` -> ${t.value}` : '';
    return `  ${i + 1}. ${t.tier.padEnd(7)} ${input}  [${t.result}] ${t.reason || ''}${value}`;
  });
}

function registryStatusSuffix(javaHome) {
  // An empty or relative JAVA_HOME is a MALFORMED entry, not a JDK whose java.exe happens to
  // be absent - saying "MISSING bin\java.exe" would send the reader looking in the wrong place.
  if (!javaHome || !path.isAbsolute(javaHome)) return '[MALFORMED entry]';
  try {
    if (fs.statSync(javaExeIn(javaHome)).isFile()) {
      const release = readRelease(javaHome);
      return release ? `[ok]      release=${release}` : '[ok]';
    }
  } catch {
    /* fall through */
  }
  return '[MISSING bin\\java.exe]';
}

function legacyConfigHint(dir) {
  const legacy = path.join(dir, 'jenv.config.json');
  try {
    if (fs.existsSync(legacy)) {
      return (
        `Note: a legacy PowerShell config exists at ${legacy}. This server reads only the txt ` +
        'registry used by the batch implementation, so entries there are not visible here.'
      );
    }
  } catch {
    /* ignore */
  }
  return null;
}

function listText(registry, cwd, resolution) {
  const lines = [];
  lines.push(`JEnv registry: ${registry.dir}`);
  lines.push('');

  const empty = !registry.files.jenvs.exists && !registry.files.locals.exists && !registry.files.global.exists;

  if (empty) {
    lines.push('The JEnv registry is empty. None of the three registry files exist:');
    lines.push('  jenvs.txt   not found');
    lines.push('  locals.txt  not found');
    lines.push('  global.txt  not found');
    lines.push('');
    lines.push('Nothing is registered, so no JDK can be resolved. JEnv (the cmd/PowerShell tool) writes');
    lines.push('these files when you run:');
    lines.push('  jenv add <name> <path-to-JAVA_HOME>     e.g. jenv add java17 E:\\JDK_java\\jdk_17');
    lines.push('  jenv change <name>                      sets the global default');
    lines.push('  jenv local <name>                       binds the current directory');
    lines.push('This server is read-only and will never create them.');
    lines.push('Tip: jenv_current and jenv_run accept a `use` parameter so you can target a JDK path');
    lines.push('directly without registering it.');
  } else {
    lines.push('Registered JDKs (jenvs.txt):');
    if (registry.jenvs.length === 0) {
      lines.push('  (none)');
    } else {
      for (const entry of registry.jenvs) {
        lines.push(`  ${entry.key}    ${entry.value}    ${registryStatusSuffix(entry.value)}`);
      }
    }
    lines.push('');
    lines.push('Local bindings (locals.txt):');
    if (registry.locals.length === 0) {
      lines.push('  (none)');
    } else {
      for (const entry of registry.locals) {
        let mark = '';
        try {
          if (!fs.statSync(entry.value).isDirectory()) mark = '    [directory missing]';
        } catch {
          mark = '    [directory missing]';
        }
        lines.push(`  ${entry.key}    ${entry.value}${mark}`);
      }
    }
    lines.push('');
    lines.push('Global default (global.txt):');
    lines.push(registry.global ? `  ${registry.global.value}    ${registryStatusSuffix(registry.global.value)}` : '  (none)');
    lines.push('');
    if (resolution.resolved) {
      lines.push(
        `Active for ${cwd}: ${resolution.source} -> ${resolution.javaHome}` +
          (resolution.release ? ` (release ${resolution.release})` : '')
      );
    } else {
      lines.push(`Active for ${cwd}: nothing resolves.`);
    }
  }

  const hint = legacyConfigHint(registry.dir);
  if (hint) {
    lines.push('');
    lines.push(hint);
  }

  return lines.join('\n');
}

function currentText(resolution, verbose) {
  if (!resolution.resolved) return noJdkMessage(resolution);

  const lines = [];
  lines.push(`cwd:        ${resolution.cwd}`);
  lines.push(`source:     ${resolution.source}`);
  lines.push(`JAVA_HOME:  ${resolution.javaHome}`);
  lines.push(
    `java:       ${resolution.javaExe || '(unusable JAVA_HOME)'}  (${resolution.javaExeExists ? 'exists' : 'MISSING'})`
  );
  lines.push(`version:    ${resolution.release || '(unknown - no release file)'}`);
  if (resolution.matched && resolution.matched.file) {
    lines.push(
      `matched:    ${resolution.matched.file} line ${resolution.matched.line}: ` +
        `${resolution.matched.key !== null ? `${resolution.matched.key}=` : ''}${resolution.matched.value}`
    );
  }
  if (verbose) {
    lines.push('');
    lines.push('trace:');
    lines.push(...traceLines(resolution.trace));
  }
  lines.push('');
  lines.push('To use this JDK in your own shell (this server will not change your environment):');
  lines.push(`  set "JAVA_HOME=${resolution.javaHome}"`);
  const binDir = binDirOf(resolution.javaHome);
  if (binDir) lines.push(`  set "PATH=${binDir};%PATH%"`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'jenv_list',
    title: 'List registered JDKs and directory bindings',
    description:
      'Read the JEnv registry (jenvs.txt / locals.txt / global.txt under %APPDATA%\\JEnv) and return ' +
      'every registered JDK, every per-directory binding, and the global default. Use this to discover ' +
      'the names accepted by the `use` parameter of the other tools. Read-only: this tool never writes ' +
      'to the registry or the environment.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description:
            'Optional directory, used only to mark which local binding would apply there. Defaults to the server working directory.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler(params, registry) {
      const cwd = path.resolve(typeof params.cwd === 'string' && params.cwd ? params.cwd : process.cwd());
      // jenv_list exists to enumerate the registry. A bad optional `cwd` must not cost the
      // caller the whole answer, so degrade to "no binding for this directory" instead of
      // throwing - which previously returned no registry data at all.
      let resolution;
      try {
        resolution = resolveJdk(registry, { cwd });
      } catch (err) {
        if (!(err instanceof ToolError) || err.code !== 'E_CWD_INVALID') throw err;
        resolution = unresolved(cwd, [err.message]);
      }
      const warnings = [...registry.warnings, ...resolution.warnings];
      const text = listText(registry, cwd, resolution) + warningBlock(warnings);

      const structuredContent = {
        registryDir: registry.dir,
        registryDirSource: registry.dirSource,
        files: {
          jenvs: registry.files.jenvs,
          locals: registry.files.locals,
          global: registry.files.global,
        },
        jenvs: registry.jenvs.map((e) => ({
          name: e.key,
          path: e.value,
          javaExeExists: existsAsFile(javaExeIn(e.value)),
          release: readRelease(e.value),
        })),
        locals: registry.locals.map((e) => ({ name: e.key, dir: e.value, dirExists: existsAsDir(e.value) })),
        global: registry.global
          ? {
              path: registry.global.value,
              javaExeExists: existsAsFile(javaExeIn(registry.global.value)),
              release: readRelease(registry.global.value),
            }
          : null,
        activeForCwd: resolution.resolved
          ? { cwd, source: resolution.source, javaHome: resolution.javaHome, release: resolution.release }
          : { cwd, source: 'none', javaHome: null },
        warnings,
      };

      return { text, isError: false, structuredContent };
    },
  },
  {
    name: 'jenv_current',
    title: 'Resolve the effective JDK for a directory',
    description:
      'Resolve which JDK is in effect, and why, using the same rules as `jenv getjava`: a `use` override, ' +
      'then an exact match of the directory against locals.txt, then global.txt. Returns JAVA_HOME, the ' +
      'java executable path, whether it exists, and the version read from the JDK release file (no java ' +
      'process is spawned). Also returns a step-by-step trace of every tier that was checked, so a failed ' +
      'resolution is self-diagnosing. Pass `use` to target a specific registered name or absolute JDK path ' +
      'for this call only. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description: 'Directory to resolve for. Defaults to the server working directory. Must be an absolute path.',
        },
        use: {
          type: 'string',
          description:
            'Override for this call only: a registered JDK name (e.g. "java21") or an absolute path to a JAVA_HOME (e.g. "E:\\\\JDK_java\\\\jdk_21"). Equivalent to a JENVUSE override.',
        },
        verbose: {
          type: 'boolean',
          description: 'Include the full resolution trace in the text output. Default true.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler(params, registry) {
      const verbose = params.verbose === undefined ? true : Boolean(params.verbose);
      const resolution = resolveJdk(registry, { cwd: params.cwd, use: params.use });
      const warnings = [...registry.warnings, ...resolution.warnings];

      if (!resolution.resolved) {
        return {
          text: noJdkMessage(resolution) + warningBlock(warnings),
          isError: true,
          structuredContent: {
            resolved: false,
            cwd: resolution.cwd,
            source: 'none',
            javaHome: null,
            javaExe: null,
            release: null,
            trace: resolution.trace,
            warnings,
          },
        };
      }

      return {
        text: currentText(resolution, verbose) + warningBlock(warnings),
        isError: false,
        structuredContent: {
          resolved: true,
          cwd: resolution.cwd,
          source: resolution.source,
          javaHome: resolution.javaHome,
          javaExe: resolution.javaExe,
          javaExeExists: resolution.javaExeExists,
          release: resolution.release,
          matched: resolution.matched,
          trace: resolution.trace,
          warnings,
        },
      };
    },
  },
  {
    name: 'jenv_run',
    title: 'Run a command with a JEnv JDK injected',
    description:
      'Run an executable with JAVA_HOME set to the resolved JDK and <JAVA_HOME>\\bin placed first on the ' +
      "child's PATH, and JENVUSE set, for that child process only. The server's own environment is never " +
      'modified, so this is safe to call repeatedly and leaves no trace afterwards. Use this for mvn, ' +
      'gradle, java, javac and any other tool that needs a JDK: this machine has no java.exe on PATH, so a ' +
      'bare `java` in a plain shell fails while `jenv_run` with command "java" works, and Gradle fails with ' +
      'an empty JAVA_HOME while jenv_run supplies it. `command` is resolved against <JAVA_HOME>\\bin and ' +
      'then PATH, trying .exe, .cmd, .bat, .com in that order. .cmd/.bat targets are launched via cmd.exe; ' +
      'their arguments must not contain the cmd metacharacters listed in the README.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'Executable name (e.g. "java", "javac", "mvn", "gradle") or an absolute path to a file. Extensionless entries are skipped because Windows cannot run them.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments, passed verbatim as separate argv entries. Never a single shell string. Default [].',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the child. Defaults to the server working directory. Must exist.',
        },
        use: {
          type: 'string',
          description: 'Same as jenv_current: a registered JDK name or an absolute JAVA_HOME path, for this call only.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: MIN_TIMEOUT_MS,
          maximum: MAX_TIMEOUT_MS,
          description: `Kill the child after this many ms. Default ${DEFAULT_TIMEOUT_MS}.`,
        },
        maxOutputBytes: {
          type: 'integer',
          minimum: MIN_MAX_OUTPUT,
          maximum: MAX_MAX_OUTPUT,
          description: `Per-stream capture cap; output beyond it is dropped and a truncation marker appended. Default ${DEFAULT_MAX_OUTPUT}.`,
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Extra environment variables for the child, merged last. Optional.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async handler(params, registry) {
      const result = await runCommand(params || {}, registry);
      return result;
    },
  },
];

function warningBlock(warnings) {
  const unique = [...new Set(warnings.filter(Boolean))];
  if (unique.length === 0) return '';
  return `\n\nwarnings:\n${unique.map((w) => `  - ${w}`).join('\n')}`;
}

function existsAsFile(file) {
  if (!file) return false;
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function existsAsDir(dir) {
  if (!dir) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function visibleTools() {
  return RUNTIME_DISABLED ? TOOLS.filter((t) => t.name !== 'jenv_run') : TOOLS;
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

let stdoutBroken = false;

function send(message) {
  if (stdoutBroken) return;
  try {
    process.stdout.write(JSON.stringify(message) + '\n');
  } catch (err) {
    stdoutBroken = true;
    log(`stdout write failed (${err.message}); client is probably gone`);
  }
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: '2.0', id: id === undefined ? null : id, error });
}

function toToolResult(outcome) {
  const content = [{ type: 'text', text: outcome.text }];
  const result = { content };
  if (outcome.structuredContent !== undefined) result.structuredContent = outcome.structuredContent;
  if (outcome.isError) result.isError = true;
  return result;
}

async function handleRequest(message) {
  const method = message.method;

  if (method === 'initialize') {
    const requested = message.params && message.params.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : LATEST_PROTOCOL;
    return {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION, title: 'JEnv for Windows registry' },
      instructions: INSTRUCTIONS,
    };
  }

  if (method === 'ping') return {};

  if (method === 'tools/list') {
    return {
      tools: visibleTools().map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      })),
    };
  }

  if (method === 'tools/call') {
    const params = message.params || {};
    const name = params.name;
    if (typeof name !== 'string') {
      throw { rpc: { code: -32602, message: 'Invalid params: `name` must be a string.' } };
    }
    let args = params.arguments;
    if (args === undefined || args === null) args = {};
    if (typeof args !== 'object' || Array.isArray(args)) {
      throw { rpc: { code: -32602, message: 'Invalid params: `arguments` must be an object.' } };
    }

    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      const available = visibleTools().map((t) => t.name).join(', ');
      return {
        content: [{ type: 'text', text: `Unknown tool \`${name}\`. Available: ${available}.` }],
        isError: true,
      };
    }
    if (RUNTIME_DISABLED && name === 'jenv_run') {
      return {
        content: [
          {
            type: 'text',
            text: 'jenv_run is disabled by JENV_MCP_DISABLE_RUN. Only jenv_list and jenv_current are available.',
          },
        ],
        isError: true,
      };
    }

    const registry = parseRegistry([]);
    try {
      const outcome = await tool.handler(args, registry);
      return toToolResult(outcome);
    } catch (err) {
      if (err instanceof ToolError) {
        return {
          content: [{ type: 'text', text: err.message }],
          structuredContent: { error: err.code },
          isError: true,
        };
      }
      log(`tool ${name} threw: ${err && err.stack ? err.stack : err}`);
      return {
        content: [{ type: 'text', text: `Internal error in ${name}: ${err && err.message ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }

  throw { rpc: { code: -32601, message: `Method not found: ${method}` } };
}

async function handleLine(line) {
  if (line.length > MAX_LINE_CHARS) {
    sendError(null, -32700, `Parse error: message exceeds ${MAX_LINE_CHARS} characters`);
    return;
  }
  const trimmed = line.trim();
  if (trimmed === '') return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (err) {
    sendError(null, -32700, `Parse error: ${err.message}`);
    return;
  }

  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    sendError(null, -32600, 'Invalid Request: message must be a JSON object');
    return;
  }
  if (message.jsonrpc !== '2.0') {
    sendError(message.id, -32600, 'Invalid Request: jsonrpc must be "2.0"');
    return;
  }

  const isNotification = !Object.prototype.hasOwnProperty.call(message, 'id');

  try {
    const result = await handleRequest(message);
    if (!isNotification) sendResult(message.id === undefined ? null : message.id, result);
  } catch (err) {
    if (isNotification) {
      log(`notification ${message.method} failed: ${err && err.message ? err.message : err}`);
      return;
    }
    if (err && err.rpc) {
      sendError(message.id, err.rpc.code, err.rpc.message);
    } else {
      log(`unhandled error on ${message.method}: ${err && err.stack ? err.stack : err}`);
      sendError(message.id, -32603, `Internal error: ${err && err.message ? err.message : String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let inFlight = false;
const queue = [];
let shuttingDown = false;
let inputEnded = false;

function pump() {
  if (inFlight) return;
  const line = queue.shift();
  if (line === undefined) return;
  inFlight = true;
  process.stdin.pause();
  handleLine(line)
    .catch((err) => log(`handleLine failed: ${err && err.stack ? err.stack : err}`))
    .finally(() => {
      inFlight = false;
      if (queue.length > 0) {
        setImmediate(pump);
      } else if (!inputEnded) {
        process.stdin.resume();
      }
    });
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  inputEnded = true;
  log(`shutting down (${reason})`);

  const finish = () => {
    killAllChildren();
    process.stdout.write('', () => process.exit(0));
    // Belt and braces if the flush callback never fires.
    setTimeout(() => process.exit(0), 500).unref();
  };

  // Drain whatever is already queued (a piped client delivers everything then closes
  // stdin in the same tick), then go. The cap exists only so a long-running jenv_run
  // cannot hold the process open forever after the client has already disconnected.
  const deadline = Date.now() + 10000;
  const wait = () => {
    if ((inFlight || queue.length > 0) && Date.now() < deadline) {
      setImmediate(pump);
      setTimeout(wait, 25);
      return;
    }
    finish();
  };
  wait();
}

function main() {
  const isTTY = Boolean(process.stdin.isTTY);
  if (isTTY) {
    process.stderr.write(
      '\n' +
        `${SERVER_NAME} is a stdio MCP server. It speaks JSON-RPC 2.0 on stdin/stdout and is meant to be\n` +
        'launched by an MCP client, not run interactively. Configure it in your client, for example a\n' +
        'project-scoped .mcp.json containing:\n' +
        '\n' +
        '  {"mcpServers":{"jenv":{"command":"node","args":["<repo>/batch/mcp/server.js"]}}}\n' +
        '\n' +
        `Registry directory: ${registryDir().dir}\n` +
        'jenv_run is ' + (RUNTIME_DISABLED ? 'DISABLED (JENV_MCP_DISABLE_RUN=1)' : 'enabled') + '.\n' +
        '\n' +
        'Reading JSON-RPC from stdin anyway. Press Ctrl+C to exit.\n\n'
    );
  }

  process.stdout.on('error', (err) => {
    if (err && err.code === 'EPIPE') {
      stdoutBroken = true;
      shutdown('stdout EPIPE');
    } else {
      log(`stdout error: ${err && err.message ? err.message : err}`);
    }
  });

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });

  rl.on('line', (line) => {
    if (shuttingDown) return;
    queue.push(line);
    pump();
  });

  rl.on('close', () => shutdown('stdin closed'));
  process.stdin.on('end', () => shutdown('stdin ended'));

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    log(`uncaught exception: ${err && err.stack ? err.stack : err}`);
  });
  process.on('unhandledRejection', (err) => {
    log(`unhandled rejection: ${err && err.stack ? err.stack : err}`);
  });

  log(`ready (protocol ${LATEST_PROTOCOL}, node ${process.version}, registry ${registryDir().dir})`);
}

main();
