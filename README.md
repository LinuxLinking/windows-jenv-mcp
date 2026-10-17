# JEnv for Windows (batch implementation)

Switch between installed JDKs by name. `java` on `PATH` is intercepted by a small
`java.bat` shim that resolves the JDK you selected and forwards to it — so a
build can run under one JDK without touching another.

## Attribution and differences from upstream

This repository (`[REPO_NAME]`) is a from-scratch **cmd/batch** implementation
of **JEnv-for-Windows** ([github.com/FelixSelter/JEnv-for-Windows](https://github.com/FelixSelter/JEnv-for-Windows),
Copyright Felix Selter and contributors, Apache License 2.0). It is not a
direct port: nothing of the upstream's PowerShell code remains. See `LICENSE`
and `NOTICE` for the legal bits.

The most important behavioral difference:

> **In this implementation `JAVA_HOME` always points at the JEnv directory, at
> the user and system scope. A real JDK path is never written into `JAVA_HOME`.**
> In the upstream PowerShell implementation, `jenv change` writes the real JDK
> path into `JAVA_HOME` (session and registry). This port reverses that
> deliberately, so `jenv use` / `jenv local` always reach tools that read
> `%JAVA_HOME%` — at the cost of `Gradle`-style tools that need a real
> `%JAVA_HOME%\bin\java.exe` (the JEnv directory holds `java.bat`, not
> `java.exe`; use `java` from `PATH`).

Other notable differences: this implementation is pure batch (no PowerShell
dependency), uses three plain-text registry files instead of JSON, and ships
its own one-time `jenv install` (upstream detects and configures PATH on every
invocation). See `mcp/README.md` for the MCP server, which has no upstream
equivalent.

---

## The one invariant

> **`JAVA_HOME` always points at the JEnv directory — at the user scope *and* the
> system scope. A real JDK path is never written into `JAVA_HOME`.**

The real JDK lives only in JEnv's own registry under `%APPDATA%\JEnv`
(`jenvs.txt`, `global.txt`, `locals.txt`) and in the session-only `JENVUSE`.
It is resolved **at call time** by the shim.

Why it matters: if a real JDK were persisted into `JAVA_HOME`, any tool that
reads `%JAVA_HOME%\bin\java.exe` (Gradle, IDEs) would bypass JEnv entirely and
your `jenv use` / `jenv local` selection would silently stop reaching it.

**Consequence, accepted by design:** tools that require a real
`%JAVA_HOME%\bin\java.exe` will not resolve, because the JEnv directory holds
`java.bat`, not `java.exe`. Use `java` from `PATH` (the shim). For build tools
that genuinely need a real `JAVA_HOME`, the MCP server's `jenv_run` injects it
into a single child process.

### Where things live

| Thing | Location |
|---|---|
| The shim (intercepts `java`) | `%JENV_ROOT%\java.bat` → calls `jenv getjava` |
| Registered JDKs | `%APPDATA%\JEnv\jenvs.txt` — `name=path` per line |
| Global default | `%APPDATA%\JEnv\global.txt` — one bare `JAVA_HOME` path |
| Per-directory binding | `%APPDATA%\JEnv\locals.txt` — `name=dir` per line |
| `JAVA_HOME` (both scopes) | the JEnv directory |
| `PATH` | JEnv directory prepended, so `java.bat` wins |

`JENV_APPDATA` overrides the registry location (used by the tests).

---

## Install

Run once, from an **Administrator** prompt (machine scope needs admin; a
non-elevated run configures only the user scope and tells you to re-run):

```bat
jenv install
```

It creates the registry directory, points `JAVA_HOME` at the JEnv directory at
both scopes, and prepends the JEnv directory to `PATH`. It is idempotent.
Afterwards, open a new terminal and confirm:

```bat
where java    REM first line must be ...\batch\java.bat
```

---

## Usage

```bat
jenv add <name> <path>          REM register a JDK (absolute path)
jenv list                      REM show registered JDKs and local bindings
jenv change <name>             REM set the global default (writes global.txt)
jenv use <name>                REM override for THIS shell session only
jenv use remove                REM drop the session override
jenv local <name>              REM bind this exact directory to a JDK
jenv local remove              REM drop the directory binding
jenv remove <name>             REM unregister a JDK
jenv getjava                   REM print the JAVA_HOME that resolves right now
jenv link <exe>                REM create a shim for another executable (javac...)
jenv autoscan [--yes] [path]   REM scan for JDKs and offer to register them
jenv install                   REM (re)apply the machine configuration
jenv uninstall <name>          REM remove JEnv entirely and restore a real JDK
```

### Resolution order

`jenv getjava` (and therefore the `java` shim) picks the first that applies:

1. **`JENVUSE`** — a literal path, set by `jenv use`. Session only.
2. **`locals.txt`** — a binding whose directory *exactly* equals the working
   directory (case-insensitive). **No subfolder inheritance.**
3. **`global.txt`** — the global default.

---

## Commands that touch the registry

| Command | Effect |
|---|---|
| `add`, `remove` | write `jenvs.txt` |
| `change` | write `global.txt`; assert `JAVA_HOME` = JEnv dir at both scopes |
| `use` | set session `JENVUSE` + `JAVA_HOME`; never writes the registry |
| `local` | write `locals.txt` |
| `install` | set `JAVA_HOME` (both scopes) + prepend JEnv dir to `PATH` |
| `uninstall` | restore a real JDK, strip JEnv from `PATH`, delete the folder |

`uninstall` is the one intentional exception to the invariant: it deletes the
JEnv directory, so it restores a real JDK to `JAVA_HOME` before going away.

---

## Tests

```powershell
powershell -File tests\run-all.ps1     # everything
powershell -File tests\run-cli.ps1     # CLI sub-commands
powershell -File tests\run-mcp.ps1     # MCP server (needs node on PATH)
```

The suites build their own fake JDKs and a throwaway registry in `%TEMP%`; they
never touch the real `%APPDATA%\JEnv`, `JAVA_HOME`, or `PATH`.

---

## MCP server

`mcp\server.js` exposes the registry to AI agents as a strictly read-only MCP
server: `jenv_list`, `jenv_current`, and `jenv_run` (which injects a real
`JAVA_HOME` into a single child process). See [`mcp\README.md`](mcp/README.md)
for setup, the tool contract, and the security model.

---

## Notes and known limitations

- `local` binds the **exact** directory only; it does not cascade to
  subfolders. Enter the directory and re-run if you want it deeper.
- After `uninstall`, the chosen JDK's `bin` is appended to the **user** `PATH`,
  but Windows searches the machine `PATH` first — so if a real JDK remains on
  the machine `PATH`, `java` after uninstall may resolve to that instead.
  `JAVA_HOME` is restored correctly.
- Shims only exist for `java`, `javac`, and whatever you `jenv link`. A JDK tool
  with no shim will not be routed.
