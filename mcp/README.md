# jenv-mcp

An [MCP](https://modelcontextprotocol.io) server for the `batch/` implementation of
**JEnv for Windows**.

JEnv switches between JDK installations by putting a fake `java.bat` early on `PATH`. That
design assumes a human types `java` and lets `PATH` intercept it. AI agents do not work
that way: they write absolute paths, or they "helpfully" edit `PATH` / `JAVA_HOME` to make
a build succeed — which silently corrupts the user's carefully maintained JDK selection.

This server replaces *"the agent guesses"* with *"the agent asks"*, and adds one
controlled-execution tool that injects `JAVA_HOME` for a **single child process only**.

It is **read-only** with respect to the machine. It never modifies the registry, never
changes an environment variable of its own process, and never invokes
`jenv use` / `change` / `local` / `add` / `remove` / `uninstall` / `link`. In particular it
cannot reach `batch/jenv-change.bat`, which persists `JAVA_HOME` with a user-scope
`setx` (`batch/jenv-change.bat` deliberately avoids `/M`: machine scope demands
administrator rights for something that only needs to affect the current user), and it
cannot reach `batch/jenv-use.bat`, which leaks `JENVUSE` into the caller's session.

## Requirements

- **Windows 10/11.**
- **Node.js 18 or newer** (tested on Node 22). No `npm install`, no `node_modules` — the
  server is one file using only the Node standard library.
- The `batch/` implementation of JEnv, with a registry under `%APPDATA%\JEnv` (or
  `JENV_APPDATA`). If the registry is empty, the server says so; it never creates it.

## Register it

### Project scope (recommended — travels with the repo)

Commit a `.mcp.json` at the repository root:

```json
{
  "mcpServers": {
    "jenv": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PROJECT_DIR}/batch/mcp/server.js"]
    }
  }
}
```

`${CLAUDE_PROJECT_DIR}` is expanded by the MCP client, not by a shell. Your client will
ask you to approve a project-scoped server the first time.

### User scope (machine-wide)

```
claude mcp add jenv -s user -- node '${CLAUDE_PROJECT_DIR}/batch/mcp/server.js'
```

**The single quotes are mandatory.** Without them your shell expands
`${CLAUDE_PROJECT_DIR}` to an empty string before the CLI ever sees it, and the server
silently points at `/batch/mcp/server.js`.

### Absolute path

For a clone in an unusual location:

```
claude mcp add jenv -s user -- node "C:\path\to\JEnv-for-Windows\batch\mcp\server.js"
```

Verify with `claude mcp list` or the `/mcp` command.

### Windows note: use `node`, never a `.cmd`

MCP clients launch stdio servers with `shell: false`, so `command` must be a real
executable. `node` is a real `.exe` and works directly. Do **not** put `npx` (or any other
`.cmd` shim) in `command` — it will fail to start. If your Node is only reachable through
a shim, put the absolute path to `node.exe` in `command`.

## Tools

| Tool | Answers | Annotations |
|---|---|---|
| `jenv_list` | What JDKs are registered, what directories are bound, what the global default is | read-only |
| `jenv_current` | Which JDK applies to a directory, **and why** — with a per-tier trace | read-only |
| `jenv_run` | Run a command with that JDK injected, for that child process only | executes code |

### `jenv_list`

Optional `cwd` marks which local binding would apply there. A `cwd` that does not exist is
**not** fatal: the registry is still returned in full, with `activeForCwd` reporting
`source: "none"` and a warning. An empty registry is likewise a successful result, not an
error — a fresh clone should not look broken.

### `jenv_current`

Returns `JAVA_HOME`, the `java.exe` path, whether it exists, and the JDK version read from
the JDK's `release` file — **no `java` process is spawned**. The trace shows every tier
that was checked, so a failed resolution explains itself.

The `use` parameter targets a registered name (`"java21"`) or an absolute JDK path
(`"E:\\JDK_java\\jdk_21"`) for that call only. It is the MCP equivalent of the `JENVUSE`
environment variable, which is unreachable here because MCP clients spawn servers with a
narrow environment whitelist.

### `jenv_run`

```
jenv_run { "use": "E:\\JDK_java\\jdk_17", "command": "gradle", "args": ["build", "-x", "test"] }
```

Sets `JAVA_HOME`, `JENVUSE`, and prepends `<JAVA_HOME>\bin` to `PATH` **for that child
only**. The server's own environment is untouched, so calls cannot interfere with each
other and nothing is left behind afterwards. On a machine with no `java.exe` on `PATH`,
a bare `java` in a plain shell fails while `jenv_run` with `command: "java"` works — and
Gradle, which fails outright when `JAVA_HOME` is empty, works too.

- `command` is resolved against `<JAVA_HOME>\bin` and then every `PATH` entry, trying
  `.exe`, `.cmd`, `.bat`, `.com` in that order. Extensionless files are **never** selected,
  because Windows cannot execute them (a POSIX `mvn` or `gradle` shell script often sits on
  `PATH` right before its `.cmd` sibling).
- `.exe` targets are spawned directly with an argv array.
- `.cmd` / `.bat` targets are launched through `cmd.exe` as
  `cmd.exe /d /v:off /s /c ""<target>" "<arg1>" "<arg2>""`. The outer quote pair and the
  `/s` flag are both required: with the pieces passed as separate argv elements instead,
  Node only quotes the elements containing a space and cmd.exe's quote rules then cut the
  command line at the wrong place — a target under `C:\Program Files (x86)\` was truncated
  to `'C:\Program'` as soon as a single argument contained a space.
- `timeoutMs` (default 120000, max 600000) kills the whole process tree.
- `maxOutputBytes` (default 1 MiB per stream) caps the captured output; beyond it, output
  is dropped and a truncation marker is appended. Numeric strings (`"5000"`) are accepted.

A non-zero exit is reported as an error result, but the full `stdout`, `stderr`, and exit
code are still returned, so compiler output is never lost.

### `env`

`env` entries are merged into the child's environment **last**, so they can override
`JAVA_HOME`, `JENVUSE` and `PATH`. Overriding `PATH` this way drops the injected
`<JAVA_HOME>\bin` prefix — merge it in yourself if that is what you want.

Two restrictions apply:

- **`ComSpec` cannot be set.** It selects the `cmd.exe` this server launches `.cmd` / `.bat`
  targets with; that launcher is chosen here on purpose, so a caller-supplied one would
  bypass the metacharacter checks entirely.
- **A value containing NUL, CR or LF is refused**, since none can appear in a Windows
  environment block. Ordinary cmd metacharacters are *fine* here (`env.PATH` may well be
  `C:\Program Files (x86)\...`): environment values are never interpolated into a command
  line.

## Resolution rules

Identical to `batch/jenv-getjava.bat`:

1. **`use` / `JENVUSE`** — a literal `JAVA_HOME` path. Highest priority.
   The `use` **parameter** additionally accepts a registered name; the `JENVUSE`
   **environment variable** does not, because `jenv-getjava.bat` echoes it verbatim and
   never treats it as a registry name. A `JENVUSE=17` therefore means the (unusable) path
   `17`, exactly as it does for `java` on `PATH`, rather than the JDK named `17`.
2. **local** — a `locals.txt` entry whose directory *exactly* equals the working directory
   (case-insensitive, compared verbatim — no trimming and no trailing-separator stripping,
   because `jenv local` writes `%CD%` as-is). **There is no subfolder inheritance**:
   `jenv local` in a parent directory does not apply to its children. If the bound name
   exists in `jenvs.txt` but has an **empty** path, this tier is skipped (with a warning)
   and resolution falls through to the global default, matching the batch.
3. **global** — the last non-empty line of `global.txt`.

A `JAVA_HOME` that is not absolute is reported as unusable everywhere, rather than being
turned into a relative `bin\java.exe` that would be resolved against the server's own
working directory.

The registry lives in `%APPDATA%\JEnv`:

| File | Contents |
|---|---|
| `jenvs.txt` | registered JDKs, `name=path`, one per line |
| `locals.txt` | directory bindings, `name=dir`, one per line |
| `global.txt` | one bare `JAVA_HOME` path |

Both `jenvs.txt` and `locals.txt` use the same `name=value` orientation. Parsing mirrors
cmd's `for /f "usebackq tokens=1,* delims=="`: the key is everything before the **first**
`=`, the value is everything after it, empty lines and lines starting with `;` are skipped,
and when a name appears twice the **last** definition wins.

An entry whose path is empty or not absolute (a bare `java17` line, or `java17=C:jdk17`) is
reported as `[MALFORMED entry]` and never resolved. It is deliberately not turned into a
relative `bin\java.exe`, which would be looked up against the server's own working directory
and could silently "find" an unrelated file.

## Character encoding

These files are written by cmd's `echo`, so they are encoded in the **console codepage**
(CP936 / GBK on Chinese Windows), not UTF-8. The server decodes UTF-8 strictly first
(handling BOMs for UTF-8 / UTF-16LE / UTF-16BE), and falls back to GB18030 on failure.
CP936 output from Maven and Gradle is decoded the same way.

Note that the UTF-16 paths only trigger on a **BOM**: NUL is legal UTF-8, so a BOM-less
UTF-16 file decodes as valid UTF-8 whose every key and name is garbage. The practical impact
is nil — cmd's `echo` writes the console codepage, never UTF-16 — but it does mean "handles
UTF-16" is BOM-conditional.

Set `JENV_MCP_ENCODING` to force a specific decoder:

```
JENV_MCP_ENCODING=gb18030
```

In the rare case where a GBK byte sequence is also valid UTF-8, it decodes as garbage
rather than failing. If you use non-ASCII names in the registry and see mojibake, that is
the cause — set `JENV_MCP_ENCODING` explicitly, or use ASCII names.

## Security model

- Never writes the registry. Never creates `%APPDATA%\JEnv`. Never changes an environment
  variable of its own process.
- Never invokes any `jenv` subcommand.
- `jenv_run` is the only tool that starts a process, and the only one that can affect the
  filesystem (through whatever it runs).
- Arguments for `.cmd` / `.bat` targets must not contain `& | < > ^ % ! " ( )` or CR/LF.
  Such calls are **refused**, not escaped: cmd.exe re-interprets those characters even when
  they arrive as separate argv elements, and a hand-rolled escaper is a liability. Build
  flags such as `-Dkey=value`, `-x`, `--project-dir`, and plain paths are unaffected.
- The **target path** of a `.cmd` / `.bat` call carries the same risk and is checked too:
  a registry entry such as `java17=E:\JDK&calc` would otherwise make every `.cmd` launch
  execute `calc`, because cmd.exe splits the path on `&` and runs both halves. Paths
  containing `& | < > ^ % ! "` or CR/LF are refused. Spaces and parentheses are **not**
  refused — they are legal in a Windows path (`C:\Program Files (x86)`) and are made safe by
  the quoting described under `jenv_run`.
- Set `JENV_MCP_DISABLE_RUN=1` to remove `jenv_run` entirely, leaving a strictly read-only
  server.

## Troubleshooting

**"The JEnv registry is empty."** Correct if you have not registered anything with the
`batch/` implementation yet. Register from cmd (not through this server):

```
jenv add java17 E:\JDK_java\jdk_17
jenv change java17
```

A legacy PowerShell install keeps its data in `jenv.config.json`, which this server does
**not** read. It only detects that the file exists, and says so.

**`Cannot find 'mvn'` / `Found '...\mvn', but it has no executable extension.`** You hit the
extensionless POSIX shim on `PATH`. Use the bare name (so the `.cmd` sibling is found) or
pass the absolute path to `mvn.cmd`.

**`java` is not on PATH.** That is normal for a JEnv install — JEnv puts `java.bat` there,
not `java.exe`. Use `jenv_run` with `command: "java"`.

**Gradle says `JAVA_HOME is not set`.** Gradle needs `JAVA_HOME`; `jenv_run` supplies it.
Maven does not need it.

**The client reports a tool timeout before `timeoutMs` elapses.** The client enforces its
own limit. Lower `timeoutMs` below the client's, or raise the client's.

## Non-goals

- No write tools. Switching JDK versions is deliberately not exposed to agents.
- No migration from `jenv.config.json`.
- No disk scanning. The server's value is being a faithful mirror of the registry that
  `jenv getjava` reads; scanning would make it a second, disagreeing source of truth.
