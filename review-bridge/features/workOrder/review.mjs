import fsp from "node:fs/promises";
import path from "node:path";
import {
  acquireLock,
  appendIoEvent,
  classifyProviderFailure,
  codexDiagnosticTrailer,
  ensureDir,
  fileExists,
  listJson,
  parseReviewerUsage,
  readEvidenceTail,
  readJson,
  runProcess,
  writeFailureRecord,
  writeJson,
  writeText,
} from "../../service/index.mjs";
import { assertUnder } from "../../utils/pathGuard.mjs";
import { validateJobPolicy } from "../../policy/policyChecks.mjs";
import { buildReadList } from "./writerPrompt.mjs";
import { loadContract } from "./contract.mjs";
import { clearProcess, recordProcessOrKill, runMustStop } from "./processRecords.mjs";
import {
  controllerScopeResult,
  parseCodexJsonl,
  pathFromCommand,
  REVIEW_RESULT_SCHEMA,
  reviewerUsageEvent,
  writerClaimMismatch,
} from "./typedResults.mjs";

export const REVIEW_INPUT_OPEN = "=== review.input ===";
export const REVIEW_INPUT_CLOSE = "=== end review.input ===";

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
  const reviewerExecutable = await adapter.resolveExecutable("codex");
  return {
    valid: true,
    repo_root: paths.repoRoot,
    queue_root: paths.queueRoot,
    reviews_dir: paths.reviewsRoot,
    reviewer_executable: reviewerExecutable,
    prompt_template: reviewPromptPath,
    priority: control.reviewer_policy?.priority,
    reasoning_effort: control.reviewer_policy?.effort,
  };
}

// T0-05 D2.2: the packet the reviewer gets. Zero model: card text, typed claims, delta hashes.
export async function buildReviewInput({ paths, job, control }) {
  const workPackage = control.run?.work_package || {};
  // The reviewer reads the same sealed contract as the writer; a changed file stops the review.
  const contractSha256 = control.run?.contract_sha256 || null;
  const work = contractSha256
    ? { contract_sha256: contractSha256, contract: await loadContract(paths, contractSha256) }
    : { contract_sha256: null, work: workPackage.task };
  const delta = job.workspace_evidence?.delta_path ? await readJson(job.workspace_evidence.delta_path).catch(() => null) : null;
  const changed = (delta?.changed_files || []).map((entry) => ({
    path: entry.path, change: entry.change, before_sha256: entry.before_sha256 ?? null, after_sha256: entry.after_sha256 ?? null,
    attribution: entry.attribution ?? null,
  }));
  // Without Git there is no delta: the writer's claims are the only list, and they stay untrusted.
  const proofless = delta?.mode === "none";
  const claimed = (job.writer_result?.changed || []).map((entry) => entry.path);
  const openFindings = Array.isArray(job.open_findings) ? job.open_findings : [];
  return {
    event: "review.input",
    work_order: workPackage.work_package_id,
    call: job.call,
    priority: job.priority,
    ...work,
    scope: {
      change_types: workPackage.scope?.change_types || [],
      allowed_paths: workPackage.scope?.allowed_paths || [],
      forbidden_paths: workPackage.scope?.forbidden_paths || [],
    },
    writer_result: job.writer_result,
    delta: changed,
    scope_violations: job.workspace_evidence?.scope_violations || [],
    work_proof: {
      mode: delta?.mode || "unknown",
      start_point: delta?.start_point || "unknown",
      scope_status: delta?.scope_status || "unverified",
      commits_since_start: delta?.commits_since_start || [],
      scope_unverified: delta?.scope_unverified || [],
    },
    writer_claim_mismatch: writerClaimMismatch(job.writer_result, changed),
    // T0-06 G3.4: the controller's own test run, as evidence; the reviewer does not rerun it.
    test_result: job.test_result || null,
    work_version: job.work_version || null,
    open_findings: openFindings,
    read_list: buildReadList({ deltaPaths: proofless ? claimed : changed.map((entry) => entry.path), findings: openFindings }),
    output_schema: "review.result",
  };
}

function reviewerReadEvents(commands, readList) {
  return commands.map((command) => {
    const relative = pathFromCommand(command);
    const inList = relative ? readList.some((entry) => relative === entry.path || relative.startsWith(entry.path + "/")) : null;
    return { tool: "command", command, ...(relative ? { path: relative } : {}), outside_list: relative ? !inList : null };
  });
}

export async function runReviewWorker({
  paths,
  control,
  adapter,
  dryRun = false,
  noNotification = false,
  only = null,
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
  const reviewerExecutable = await adapter.resolveExecutable("codex");
  // A run reviewing its own job takes no project lock: claiming the job by moving it from pending to
  // running is atomic, so other runs' reviews go on beside it. The review command, which works
  // through every pending job, still runs one at a time.
  const release = only ? null : await acquireLock(paths.workerLockPath);
  const outcomes = [];
  try {
    const jobs = await listJson(paths.pendingDir);
    for (const pendingPath of jobs) {
      const name = path.basename(pendingPath);
      const jobId = path.basename(name, ".json");
      // T0-05: a bounded run reviews its own job only; other pending jobs wait for their owner.
      if (only && jobId !== only) continue;
      const runningPath = path.join(paths.runningDir, name);
      const donePath = path.join(paths.doneDir, name);
      const failedPath = path.join(paths.failedDir, name);
      const reportPath = path.join(paths.reviewsRoot, jobId + "-writer-report.md");
      const resultPath = path.join(paths.reviewsRoot, jobId + "-reviewer-review.md");
      const promptPath = path.join(paths.reviewsRoot, jobId + "-review-prompt.md");
      const metadataPath = path.join(paths.reviewsRoot, jobId + "-job.json");
      const stdoutPath = path.join(paths.reviewsRoot, jobId + "-reviewer.stdout.log");
      const stderrPath = path.join(paths.reviewsRoot, jobId + "-reviewer.stderr.log");
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

      let providerFailure = null;
      try {
        const job = await readJson(runningPath);
        validateJobPolicy(job, control);
        await writeJson(metadataPath, job);
        await writeText(reportPath, String(job.last_assistant_message));
        const runId = job.authorization?.run_id || null;
        const template = await fsp.readFile(reviewPromptPath, "utf8");
        const reviewInput = await buildReviewInput({ paths, job, control });
        if (runId) await appendIoEvent(paths, runId, reviewInput);
        const prompt = renderPrompt(template, {
          JOB_PATH: metadataPath,
          REPORT_PATH: reportPath,
          REPO_ROOT: paths.repoRoot,
          PRIORITY: job.priority,
          REASONING_EFFORT: job.reasoning_effort,
          RULES: String(control.run?.work_package?.rules?.text || "").trim(),
          REVIEW_INPUT: [REVIEW_INPUT_OPEN, JSON.stringify(reviewInput, null, 2), REVIEW_INPUT_CLOSE].join("\n"),
        });
        await writeText(promptPath, prompt);

        let exitCode = 0;
        let timedOut = false;
        let usage = null;
        let reads = [];
        let controllerDecided = false;
        const startedAt = Date.now();
        if (dryRun) {
          await writeText(resultPath, [
            "# Review Bridge Dry Run",
            "",
            "PASS: queue, prompt rendering, path checks, and result routing completed.",
            "",
            "Job: `" + jobId + "`",
            "Priority: `" + job.priority + "`",
            "Reasoning effort: `" + job.reasoning_effort + "`",
            "",
            "No reviewer model call was made.",
          ].join("\n") + "\n");
        } else if (reviewInput.scope_violations.length) {
          // D2.5: out-of-scope changes are decided here; the reviewer is not asked.
          controllerDecided = true;
          await writeJson(resultPath, controllerScopeResult({
            workOrder: reviewInput.work_order, call: job.call, scopeViolations: reviewInput.scope_violations,
            contractSha256: reviewInput.contract_sha256,
          }));
        } else {
          const reviewerArgs = [
            "--ask-for-approval", "never",
            "-c", "model_reasoning_effort=\"" + job.reasoning_effort + "\"",
            // A model of null leaves the choice to the CLI.
            ...(control.reviewer_policy?.model ? ["--model", control.reviewer_policy.model] : []),
            "exec",
            "--ephemeral",
            // A project without Git is still reviewed (Owner 2026-10-17); Codex otherwise refuses an
            // untrusted folder. The session stays read-only.
            "--skip-git-repo-check",
            "--sandbox", "read-only",
            "--cd", paths.repoRoot,
            "--output-schema", REVIEW_RESULT_SCHEMA, "--json",
            "--output-last-message", resultPath,
            "-",
          ];
          const invocation = adapter.buildInvocation("codex", reviewerExecutable, reviewerArgs);
          // The reviewer's pid is recorded like the writer's, so a stop during the review reaches it.
          const processResult = await runProcess({
            invocation,
            cwd: paths.repoRoot,
            input: prompt,
            stdoutPath,
            stderrPath,
            onSpawn: runId ? (pid) => recordProcessOrKill(paths, runId, { pid, role: "reviewer", provider: "codex", job_id: jobId, call: job.call }) : null,
          });
          await clearProcess(paths, runId);
          exitCode = processResult.exitCode;
          timedOut = Boolean(processResult.timedOut);
          // D5: usage and commands from the JSONL stream; the stderr trailer is the fallback.
          const stream = parseCodexJsonl(await fsp.readFile(stdoutPath, "utf8").catch(() => ""));
          const trailer = parseReviewerUsage(await fsp.readFile(stderrPath, "utf8").catch(() => ""), { jobId });
          usage = reviewerUsageEvent({
            usage: stream.usage, trailerTokens: trailer.tokens_used, call: job.call, durationMs: Date.now() - startedAt,
          });
          reads = reviewerReadEvents(stream.commands, reviewInput.read_list);
          if (runId) {
            for (const read of reads) await appendIoEvent(paths, runId, { event: "read", role: "reviewer", call: job.call, ...read });
            await appendIoEvent(paths, runId, usage);
          }
          // Stopped during the review: the job is closed as stopped, its output is not taken, and a
          // non-zero exit caused by the kill is not a reviewer failure.
          if (runId && await runMustStop(paths, runId)) {
            const stoppedJob = { ...job, status: "stopped", completed_at: new Date().toISOString() };
            await writeJson(runningPath, stoppedJob);
            await writeJson(metadataPath, stoppedJob);
            await fsp.rename(runningPath, failedPath);
            outcomes.push({ job_id: jobId, status: "stopped" });
            continue;
          }
        }

        if (exitCode !== 0 || !(await fileExists(resultPath)) || (await fsp.stat(resultPath)).size === 0) {
          const classified = classifyProviderFailure({
            role: "reviewer",
            provider: "codex",
            phase: "review",
            exitCode,
            timedOut,
            texts: [codexDiagnosticTrailer(await readEvidenceTail(stderrPath))],
          });
          const written = await writeFailureRecord(paths, paths.reviewsRoot, jobId, classified, {
            stdout_path: stdoutPath,
            stderr_path: stderrPath,
            report_path: reportPath,
          });
          providerFailure = { ...written.record, record_path: written.record_path };
          throw new Error("The review failed or produced no result (exit code " + exitCode + ").");
        }
        const completed = {
          ...job,
          status: "done",
          completed_at: new Date().toISOString(),
          result_path: resultPath,
          reviewer_exit_code: exitCode,
          controller_decided: controllerDecided,
        };
        await writeJson(runningPath, completed);
        await writeJson(metadataPath, completed);
        await fsp.rename(runningPath, donePath);
        outcomes.push({
          job_id: jobId, status: "done", result_path: resultPath,
          typed: true, controller_decided: controllerDecided, usage, reads, review_input: reviewInput,
        });
        if (!dryRun) await writeText(paths.latestPath, resultPath + "\n");
        if (!noNotification) await adapter.notify("Review complete", resultPath);
      } catch (error) {
        const errorPath = path.join(paths.reviewsRoot, jobId + "-error.txt");
        await writeText(errorPath, new Date().toISOString() + "\n" + error.message + "\n");
        let preservedJobPath = null;
        if (await fileExists(runningPath)) {
          preservedJobPath = runningPath;
          try {
            const job = await readJson(runningPath);
            const failed = {
              ...job,
              status: "failed",
              failed_at: new Date().toISOString(),
              error_path: errorPath,
              provider_failure: providerFailure,
            };
            await writeJson(runningPath, failed);
            await writeJson(metadataPath, failed);
            await fsp.rename(runningPath, failedPath);
            preservedJobPath = failedPath;
          } catch {
            // Keep the running job and error artifact for manual recovery.
          }
        }
        outcomes.push({
          job_id: jobId,
          status: "failed",
          error_path: errorPath,
          job_path: preservedJobPath && await fileExists(preservedJobPath) ? preservedJobPath : null,
          provider_failure: providerFailure,
        });
        if (!noNotification) await adapter.notify("Review failed", errorPath);
      }
    }
  } finally {
    await release?.();
  }
  return outcomes;
}
