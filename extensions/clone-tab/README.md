# Clone Tab

`/clone-tab` clones the active conversation branch into a separate Pi session file and opens it as a new tab in the originating Ghostty window. The original Pi process and session continue unchanged.

The cloned Pi is unrestricted: it uses the same working directory and normal user/project configuration as any independently launched Pi session.

## Behavior

- When Pi is idle, the clone includes the exact current leaf.
- While the original agent is running, the command executes immediately and clones through the latest fully completed turn. Partially streamed assistant or tool activity is never copied.
- The two conversations do not synchronize after cloning.
- The two processes use separate session JSONL files but the same working directory.

## Requirements

- macOS
- Ghostty 1.3 or newer with AppleScript support enabled
- A persisted Pi session containing at least one cloneable entry

macOS may request Automation permission the first time `osascript` controls Ghostty. The extension uses Ghostty's native scripting API and does not require Accessibility permission or simulated keystrokes.

Set `PI_CLONE_TAB_PI` to an executable path if the child tab should launch a different `pi` binary. Otherwise the extension resolves `pi` from the current process's `PATH`.
