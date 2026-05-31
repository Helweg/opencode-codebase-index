import { compareSummaries } from "./compare.js";
import { createSummaryMarkdown, createRunDirectory, loadSummary, writeJson, writeText } from "./reports.js";
import { runEvaluation, runSweep } from "./runner.js";
import * as path from "path";

import {
  hasSweepOptions,
  parseEvalSubcommandOptions,
  printUsage,
  toRunOptions,
} from "./cli-parser.js";

export async function handleEvalCommand(args: string[], cwd: string): Promise<number> {
  const subcommand = args[0];

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return 0;
  }

  if (subcommand === "run") {
    const { parsed, explicitAgainst } = parseEvalSubcommandOptions(args.slice(1), cwd);
    if (explicitAgainst) {
      parsed.againstPath = explicitAgainst;
    }
    const runOptions = toRunOptions(parsed);

    if (hasSweepOptions(parsed.sweep)) {
      const sweep = await runSweep(runOptions, parsed.sweep);
      console.log(`Eval sweep complete. Artifacts: ${sweep.outputDir}`);
      console.log(`Sweep runs: ${sweep.aggregate.runCount}`);
      if (parsed.ciMode && sweep.aggregate.gatePassed === false) {
        console.error(
          `[CI-GATE] Sweep failed: ${sweep.aggregate.failedGateRuns ?? 0} run(s) violated budget/baseline gates`
        );
        return 1;
      }
      return 0;
    }

    const result = await runEvaluation(runOptions);
    console.log(`Eval run complete. Artifacts: ${result.outputDir}`);
    console.log(
      `Hit@5=${(result.summary.metrics.hitAt5 * 100).toFixed(2)}% MRR@10=${result.summary.metrics.mrrAt10.toFixed(4)} p95=${result.summary.metrics.latencyMs.p95.toFixed(3)}ms`
    );

    if (result.gate && !result.gate.passed) {
      for (const violation of result.gate.violations) {
        console.error(`[CI-GATE] ${violation.metric}: ${violation.message}`);
      }
      return 1;
    }

    return 0;
  }

  if (subcommand === "compare") {
    const { parsed, explicitAgainst } = parseEvalSubcommandOptions(args.slice(1), cwd);

    if (!explicitAgainst) {
      throw new Error("eval compare requires --against <baseline summary.json>");
    }
    parsed.againstPath = explicitAgainst;

    const runOptions = toRunOptions(parsed);

    if (hasSweepOptions(parsed.sweep)) {
      const sweep = await runSweep(runOptions, parsed.sweep);
      console.log(`Eval compare sweep complete. Artifacts: ${sweep.outputDir}`);
      if (parsed.ciMode && sweep.aggregate.gatePassed === false) {
        console.error(
          `[CI-GATE] Sweep failed: ${sweep.aggregate.failedGateRuns ?? 0} run(s) violated budget/baseline gates`
        );
        return 1;
      }
      return 0;
    }

    const result = await runEvaluation(runOptions);
    console.log(`Eval compare complete. Artifacts: ${result.outputDir}`);
    return 0;
  }

  if (subcommand === "diff") {
    const { parsed, explicitAgainst } = parseEvalSubcommandOptions(args.slice(1), cwd);
    if (!explicitAgainst) {
      throw new Error("eval diff requires --against <baseline summary.json>");
    }
    if (!parsed.currentPath) {
      throw new Error("eval diff requires --current <current summary.json>");
    }
    parsed.againstPath = explicitAgainst;

    const currentPath = parsed.currentPath;
    if (!currentPath.endsWith(".json")) {
      throw new Error("eval diff --current must point to a summary JSON file");
    }
    if (!parsed.againstPath.endsWith(".json")) {
      throw new Error("eval diff --against must point to a summary JSON file");
    }
    const currentSummary = loadSummary(path.resolve(parsed.projectRoot, currentPath), {
      allowLegacyDiversityMetrics: true,
    });
    const baselineSummary = loadSummary(path.resolve(parsed.projectRoot, parsed.againstPath), {
      allowLegacyDiversityMetrics: true,
    });
    const comparison = compareSummaries(
      currentSummary,
      baselineSummary,
      path.resolve(parsed.projectRoot, parsed.againstPath)
    );

    const outputDir = createRunDirectory(path.resolve(parsed.projectRoot, parsed.outputRoot));
    const summaryMd = createSummaryMarkdown(currentSummary, comparison);
    writeJson(path.join(outputDir, "compare.json"), comparison);
    writeText(path.join(outputDir, "summary.md"), summaryMd);
    writeJson(path.join(outputDir, "summary.json"), currentSummary);
    console.log(`Eval diff complete. Artifacts: ${outputDir}`);
    return 0;
  }

  throw new Error(`Unknown eval subcommand: ${subcommand}`);
}
