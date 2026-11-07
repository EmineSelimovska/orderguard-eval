import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeReport({
  target,
  results,
  runIds,
  startedAt,
  finishedAt,
}) {
  const outputDir = path.resolve('reports');

  await mkdir(outputDir, { recursive: true });

  const totalChecks = results.reduce(
    (sum, result) => sum + result.checks.length,
    0,
  );

  const passedChecks = results.reduce(
    (sum, result) =>
      sum + result.checks.filter((check) => check.passed).length,
    0,
  );

  const report = {
    generatedAt: new Date().toISOString(),
    target,
    startedAt,
    finishedAt,
    durationMs: new Date(finishedAt) - new Date(startedAt),
    summary: {
      scenarios: results.length,
      passedScenarios: results.filter((result) => result.passed).length,
      failedScenarios: results.filter((result) => !result.passed).length,
      totalChecks,
      passedChecks,
      failedChecks: totalChecks - passedChecks,
      passed: results.every((result) => result.passed),
    },
    runIds,
    scenarios: results,
  };

  const timestamp = new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replaceAll('.', '-');

  const jsonPath = path.join(outputDir, `report-${timestamp}.json`);
  const markdownPath = path.join(outputDir, `report-${timestamp}.md`);

  await writeFile(jsonPath, JSON.stringify(report, null, 2));

  const markdown = [
    '# OrderGuard Eval Report',
    '',
    `- Target: ${target}`,
    `- Generated: ${report.generatedAt}`,
    `- Duration: ${report.durationMs} ms`,
    '',
    '## Summary',
    '',
    `- Scenarios: ${report.summary.passedScenarios}/${report.summary.scenarios} passed`,
    `- Checks: ${passedChecks}/${totalChecks} passed`,
    `- Overall: ${report.summary.passed ? 'PASSED' : 'FAILED'}`,
    '',
    '## Scenario details',
    '',
    ...results.flatMap((result) => [
      `### ${result.scenario}: ${result.passed ? 'PASSED' : 'FAILED'}`,
      '',
      `- Checks: ${result.checks.filter((check) => check.passed).length}/${result.checks.length}`,
      '',
      ...result.checks.map(
        (check) => `- ${check.passed ? 'PASS' : 'FAIL'} — ${check.name}`,
      ),
      '',
    ]),
  ].join('\n');

  await writeFile(markdownPath, markdown);

  return { jsonPath, markdownPath, report };
}