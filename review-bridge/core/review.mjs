import fsp from "node:fs/promises";
import path from "node:path";
import {
  acquireLock,
  assertUnder,
  ensureDir,
  fileExists,
  listJson,
  readJson,
  writeJson,
  writeText,
} from "./io.mjs";
import { runProcess } from "./process.mjs";
import { validateJobPolicy } from "./policy.mjs";

function renderPrompt(template, values) {
  let output = template;
  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll("{{" + key + "}}", String(value));
  }
  return output;
}

async function resolveReviewPromptPath(paths) {
  if (await fileExists(paths.reviewPromptOverridePath)) return paths.reviewPromptOverridePath;
  return paths.reviewPromptPath;
}

export async function validateReviewWorker({ paths, control, adapter }) {
  const reviewPromptPath = await resolveReviewPromptPath(paths);
  if (!(await fileExists(reviewPromptPath))) {
    throw new Error("Review prompt template is missing.");
  }
  const codex = await adapter.resolveExecutable("codex");
  return {
    valid: true,
    repo_root: paths.repoRoot,
    queue_root: paths.queueRoot,
    reviews_dir: paths.reviewsRoot,
    codex,
    prompt_template: reviewPromptPath,
    default_review_level: control.codex_policy?.default_review_level,
    effort_by_level: control.codex_policy?.effort_by_level,
    classification_profile: control.codex_policy?.classification_profile,
  };
}

export async function runReviewWorker({
  paths,
  control,
  adapter,
  dryRun = false,
  noNotification = false,
}) {
  const reviewPromptPath = await resolveReviewPromptPath(paths);
  for (const directory of [
    paths.queueRoot,
    paths.pendingDir,
    paths.runningDir,
    paths.doneDir,
    paths.failedDir,
    paths.reviewsRoot,
  ]) {
    assertUnder(directory, paths.privateRoot, "Bridge runtime directory");
    await ensureDir(directory);
  }
  if (!(await fileExists(reviewPromptPath))) {
    throw new Error("Review prompt template is missing.");
  }
  const codex = await adapter.resolveExecutable("codex");
  const release = await acquireLock(paths.workerLockPath);
  try {
    const jobs = await listJson(paths.pendingDir);
    for (const pendingPath of jobs) {
      const name = path.basename(pendingPath);
      const jobId = path.basename(name, ".json");
      const runningPath = path.join(paths.runningDir, name);
      const donePath = path.join(paths.doneDir, name);
      const failedPath = path.join(paths.failedDir, name);
      const reportPath = path.join(paths.reviewsRoot, jobId + "-claude-report.md");
      const resultPath = path.join(paths.reviewsRoot, jobId + "-codex-review.md");
      const promptPath = path.join(paths.reviewsRoot, jobId + "-review-prompt.md");
      const metadataPath = path.join(paths.reviewsRoot, jobId + "-job.json");
      const stdoutPath = path.join(paths.reviewsRoot, jobId + "-codex.stdout.log");
      const stderrPath = path.join(paths.reviewsRoot, jobId + "-codex.stderr.log");
      for (const candidate of [
        runningPath, donePath, failedPath, reportPath, resultPath,
        promptPath, metadataPath, stdoutPath, stderrPath,
      ]) assertUnder(candidate, paths.privateRoot, "Review artifact");

      try {
        await fsp.rename(pendingPath, runningPath);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }

      try {
        const job = await readJson(runningPath);
        validateJobPolicy(job, control);
        await writeJson(metadataPath, job);
        await writeText(reportPath, String(job.last_assistant_message));
        const template = await fsp.readFile(reviewPromptPath, "utf8");
        const prompt = renderPrompt(template, {
          JOB_PATH: metadataPath,
          REPORT_PATH: reportPath,
          REPO_ROOT: paths.repoRoot,
          REVIEW_LEVEL: job.review_level,
          REASONING_EFFORT: job.reasoning_effort,
          CLASSIFICATION_REASONS: (job.classification_reasons || []).join("; "),
        });
        await writeText(promptPath, prompt);

        let exitCode = 0;
        if (dryRun) {
          await writeText(resultPath, [
            "# Review Bridge Dry Run",
            "",
            "PASS: queue, prompt rendering, path checks, and result routing completed.",
            "",
            "Job: `" + jobId + "`",
            "Review level: `" + job.review_level + "`",
            "Reasoning effort: `" + job.reasoning_effort + "`",
            "",
            "No Codex model call was made.",
          ].join("\n") + "\n");
        } else {
          const codexArgs = [
            "--ask-for-approval", "never",
            "-c", "model_reasoning_effort=\"" + job.reasoning_effort + "\"",
            "exec",
            "--ephemeral",
            "--sandbox", "read-only",
            "--cd", paths.repoRoot,
            "--output-last-message", resultPath,
            "-",
          ];
          const invocation = adapter.buildInvocation("codex", codex, codexArgs);
          const processResult = await runProcess({
            invocation,
            cwd: paths.repoRoot,
            input: prompt,
            stdoutPath,
            stderrPath,
          });
          exitCode = processResult.exitCode;
        }

        if (exitCode !== 0 || !(await fileExists(resultPath)) || (await fsp.stat(resultPath)).size === 0) {
          throw new Error("Codex review failed or produced no result (exit code " + exitCode + ").");
        }
        const completed = {
          ...job,
          status: "done",
          completed_at: new Date().toISOString(),
          result_path: resultPath,
          codex_exit_code: exitCode,
        };
        await writeJson(runningPath, completed);
        await writeJson(metadataPath, completed);
        await fsp.rename(runningPath, donePath);
        if (!dryRun) await writeText(paths.latestPath, resultPath + "\n");
        if (!noNotification) await adapter.notify("Codex review complete", resultPath);
      } catch (error) {
        const errorPath = path.join(paths.reviewsRoot, jobId + "-error.txt");
        await writeText(errorPath, new Date().toISOString() + "\n" + error.message + "\n");
        if (await fileExists(runningPath)) {
          try {
            const job = await readJson(runningPath);
            const failed = {
              ...job,
              status: "failed",
              failed_at: new Date().toISOString(),
              error_path: errorPath,
            };
            await writeJson(runningPath, failed);
            await writeJson(metadataPath, failed);
            await fsp.rename(runningPath, failedPath);
          } catch {
            // Keep the running job and error artifact for manual recovery.
          }
        }
        if (!noNotification) await adapter.notify("Codex review failed", errorPath);
      }
    }
  } finally {
    await release();
  }
}
