# Code Review

`/code-review` runs independent, read-only reviews of the current Git working tree, then asks the active Pi agent to verify the claims and decide what is worth doing.

## Configuration

No reviewers are enabled by default. Configure them per machine in Pi's agent directory:

```text
~/.pi/agent/code-review.json
```

If `PI_CODING_AGENT_DIR` is set, the file lives in that directory instead. A missing file is equivalent to an empty reviewer list.

```json
{
  "reviewers": [
    {
      "name": "Primary reviewer",
      "provider": "your-provider",
      "model": "your-model-id",
      "thinking": "max"
    }
  ],
  "extensions": []
}
```

Each reviewer needs a `provider` and `model`. `name` defaults to `provider/model`, and `thinking` defaults to `max`; supported levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Up to 16 unique provider/model pairs can be configured.

The top-level `extensions` array lists extension specs that child Pi processes need in order to load machine-local providers, such as `"npm:your-provider-extension"`.

## Usage

Run a general review or add an optional focus:

```text
/code-review
/code-review focus on migration safety
```

The command requires interactive TUI mode, an active model, a Git repository, and textual working-tree changes.

## What happens

1. Pi captures one snapshot of the staged, unstaged, and reviewable untracked changes.
2. Every configured reviewer receives that same snapshot in a separate Pi process. Reviewers run in parallel with read-only `read`, `grep`, `find`, and `ls` tools.
3. Each reviewer reports at most five concrete findings, along with the smallest credible candidate fix and a coarse `TINY`, `SMALL`, `MEDIUM`, or `LARGE` involvement size.
4. Pi adds a persistent summary to the transcript with each reviewer's unverified claim count and up to two sanitized titles. This summary is generated locally without another model call.
5. The current implementation agent then verifies the raised claims with its existing model, thinking level, conversation context, and normal tools. It performs targeted verification rather than another whole-patch review; no separate lead process is launched.
6. The lead opinion groups claims into `FIX NOW`, `FOLLOW-UP`, `INVESTIGATE`, or `NO ACTION`. It adds fix sizing and trade-off detail only for recommended work, or when a real issue is rejected because its remedy would be disproportionate. This adjudication turn does not edit files.

Press Escape in the progress panel to cancel an active review.

## Logs

Complete run artifacts are saved privately on the local machine under:

```text
~/.pi/agent/code-review/runs/
```

This path also follows `PI_CODING_AGENT_DIR`. Each run includes the reviewed snapshot, individual reviewer reports, and the final lead opinion when one completes.

Use `/code-review-logs` to open the newest run, or `/code-review-logs path` to print its path.
