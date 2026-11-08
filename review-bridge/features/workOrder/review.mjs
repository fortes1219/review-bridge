import fsp from "node:fs/promises";
import path from "node:path";
import {
  acquireLock,
  appendIoEvent,
  callRole,
  classifyProviderFailure,
  ensureDir,
  fileExists,
  listJson,
  readJson,
  roleProvider,
  writeFailureRecord,
  writeJson,
  writeText,
  graphMcpServer,
  reviewerGraphContext,
} from "../../service/index.mjs";
import { graphStats, readProjectGraph } from "./projectGraph.mjs";
import { assertUnder } from "../../utils/pathGuard.mjs";
import { EvidenceUnavailableError } from "./workspaceEvidence.mjs";
import { validateJobPolicy } from "../../policy/policyChecks.mjs";
import { buildReadList } from "./writerPrompt.mjs";
import { loadContract } from "./contract.mjs";
import { callTimeLeft, clearProcess, recordProcessOrKill, runMustStop } from "./processRecords.mjs";
import {
  controllerScopeResult,
  REVIEW_RESULT_SCHEMA,
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
  const reviewerExecutable = await adapter.resolveExecutable(roleProvider(control.run?.work_package, "reviewer"));
  return {
    valid: true,
    repo_root: paths.repoRoot,
    queue_root: paths.stateRoot,
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
  // Every job is queued with its change list (reviewQueue.mjs), a project without Git too (mode
  // none). One that is gone or not JSON stops the run; nothing is reviewed without it.
  const deltaPath = job.workspace_evidence?.delta_path || null;
  const delta = deltaPath ? await readJson(deltaPath).catch(() => null) : null;
  if (!delta) throw new EvidenceUnavailableError(deltaPath);
  const changed = delta.changed_files.map((entry) => ({
    path: entry.path, change: entry.change, before_sha256: entry.before_sha256 ?? null, after_sha256: entry.after_sha256 ?? null,
    attribution: entry.attribution ?? null,
  }));
  // Without Git there is no delta: the writer's claims are the only list, and they stay untrusted.
  const proofless = delta.mode === "none";
  const claimed = (job.writer_result?.changed || []).map((entry) => entry.path);
  const openFindings = Array.isArray(job.open_findings) ? job.open_findings : [];
  return {
    event: "review.input",
    work_order: workPackage.work_package_id,
    call: job.call,
    priority: job.priority,
    ...work,
    scope: {
      allowed_paths: workPackage.scope?.allowed_paths || [],
      forbidden_paths: workPackage.scope?.forbidden_paths || [],
    },
    writer_result: job.writer_result,
    delta: changed,
    scope_violations: job.workspace_evidence?.scope_violations || [],
    work_proof: {
      mode: delta.mode,
      start_point: delta.start_point,
      scope_status: delta.scope_status,
      commits_since_start: delta.commits_since_start,
      scope_unverified: delta.scope_unverified,
    },
    writer_claim_mismatch: writerClaimMismatch(job.writer_result, changed),
    // T0-06 G3.4: the controller's own test run, as evidence; the reviewer does not rerun it.
    test_result: job.test_result || null,
    work_version: job.work_version || null,
    open_findings: openFindings,
    // What broke the review's rules in this call's previous answer, when this is the second ask.
    ...(Array.isArray(job.previous_answer_problems) && job.previous_answer_problems.length ? { previous_answer_problems: job.previous_answer_problems } : {}),
    read_list: buildReadList({ deltaPaths: proofless ? claimed : changed.map((entry) => entry.path), findings: openFindings }),
    output_schema: "review.result",
  };
}

// What the reviewer read, whichever way its CLI reports it (a command, or a Read with a path that
// may be absolute), against the read list.
function reviewerReadEvents(reads, readList, repoRoot) {
  return reads.map(({ path: named, ...read }) => {
    const relative = named ? path.relative(repoRoot, path.resolve(repoRoot, named)).split(path.sep).join("/") : null;
    const inList = relative ? readList.some((entry) => relative === entry.path || relative.startsWith(entry.path + "/")) : null;
    return { ...read, ...(relative ? { path: relative } : {}), outside_list: relative ? !inList : null };
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
    paths.stateRoot,
    paths.pendingDir,
    paths.runningDir,
    paths.doneDir,
    paths.failedDir,
    paths.reviewsRoot,
  ]) {
    assertUnder(directory, paths.stateRoot, "Bridge runtime directory");
    await ensureDir(directory);
  }
  if (!(await fileExists(reviewPromptPath))) {
    throw new Error("Review prompt template is missing.");
  }
  const provider = roleProvider(control.run?.work_package, "reviewer");
  await adapter.resolveExecutable(provider);
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
      // The reviewer call's own output goes to its run's log folder once the job names the run.
      let stdoutPath = path.join(paths.reviewsRoot, jobId + "-reviewer.stdout.log");
      let stderrPath = path.join(paths.reviewsRoot, jobId + "-reviewer.stderr.log");
      for (const candidate of [
        runningPath, donePath, failedPath, reportPath, resultPath,
        promptPath, metadataPath, stdoutPath, stderrPath,
      ]) assertUnder(candidate, paths.stateRoot, "Review artifact");

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
        if (runId) {
          stdoutPath = path.join(paths.runLogDir(runId), jobId + "-reviewer.stdout.log");
          stderrPath = path.join(paths.runLogDir(runId), jobId + "-reviewer.stderr.log");
        }
        const template = await fsp.readFile(reviewPromptPath, "utf8");
        const reviewInput = await buildReviewInput({ paths, job, control });
        // What the change touches, read by Bridge from the project's graph and put into the packet.
        const changedPaths = reviewInput.delta.length ? reviewInput.delta.map((entry) => entry.path) : (job.writer_result?.changed || []).map((entry) => entry.path);
        const graph = await readProjectGraph(paths, (db, projectId) => reviewerGraphContext({ db, projectId, changedPaths }));
        if (graph?.text) reviewInput.project_graph = graph.text;
        if (runId) await appendIoEvent(paths, runId, { ...reviewInput, ...(graph ? { graph: graphStats(graph) } : {}) });
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
        let failureTexts = async () => [];
        let failureCode = null;
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
          // The review has no limit of its own; it is cut to what is left of the run's time. With
          // nothing left the run is closed as timed out and the job as stopped, before any call.
          const reviewTimeout = await callTimeLeft(paths, runId, undefined);
          if (reviewTimeout === null) {
            const stoppedJob = { ...job, status: "stopped", completed_at: new Date().toISOString() };
            await writeJson(runningPath, stoppedJob);
            await writeJson(metadataPath, stoppedJob);
            await fsp.rename(runningPath, failedPath);
            outcomes.push({ job_id: jobId, status: "stopped" });
            continue;
          }
          // The reviewer's pid is recorded like the writer's, so a stop during the review reaches it.
          // A project without Git is still reviewed (Owner 2026-10-17); the session stays read-only.
          const called = await callRole(provider, {
            adapter,
            access: "read",
            role: "reviewer",
            call: job.call,
            prompt,
            schemaPath: REVIEW_RESULT_SCHEMA,
            // A model of null leaves the choice to the CLI.
            model: control.reviewer_policy?.model ?? null,
            effort: job.reasoning_effort,
            cwd: paths.repoRoot,
            maxTurns: control.run?.policy_snapshot?.effective_policy?.limits?.max_turns ?? null,
            mcp: control.run?.work_package?.reviewer?.mcp,
            mcpOff: control.run?.work_package?.reviewer?.mcp_off,
            // Bridge's read-only graph server: what a change touches (T0-GRAPH-01); the read-only check
            // ran with it.
            graph: graphMcpServer({ bridgeRoot: paths.bridgeRoot, repoRoot: paths.repoRoot }),
            stdoutPath,
            stderrPath,
            answerPath: resultPath,
            timeoutMs: reviewTimeout,
            onSpawn: runId ? (pid) => recordProcessOrKill(paths, runId, { pid, role: "reviewer", provider, job_id: jobId, call: job.call }) : null,
          });
          await clearProcess(paths, runId);
          exitCode = called.exitCode;
          timedOut = called.timedOut;
          failureTexts = called.failureTexts;
          failureCode = called.failureCode ?? null;
          usage = called.usage;
          reads = reviewerReadEvents(called.reads, reviewInput.read_list, paths.repoRoot);
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
            provider,
            phase: "review",
            exitCode,
            timedOut,
            code: failureCode,
            texts: await failureTexts(),
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
        // The run stops on it (writerLoop.mjs); the job is kept as failed above.
        if (error instanceof EvidenceUnavailableError) throw error;
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
