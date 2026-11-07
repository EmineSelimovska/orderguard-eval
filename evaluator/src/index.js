import dotenv from "dotenv";
import { randomUUID } from "node:crypto";

import { loadConfig } from "./config/index.js";
import { startProvider, stopProvider } from "./provider/provider-manager.js";
import {
  startCandidate,
  stopCandidate,
} from "./candidate/candidate-manager.js";
import { createMongoObserver } from "./observers/mongodb-observer.js";
import { createCandidateClient } from "./candidate/candidate-client.js";
import { createProviderControl } from "./provider/provider-control.js";
import { runDuplicateOrderPrevention } from "./scenarios/duplicate-order-prevention.js";
import { runInventoryRaceCondition } from "./scenarios/inventory-race-condition.js";
import { runDuplicatePaymentWebhook } from "./scenarios/duplicate-payment-webhook.js";
import { runPaymentTimeoutRetry } from "./scenarios/payment-timeout-retry.js";
import { runCancellationVsPaymentRace } from "./scenarios/cancellation-vs-payment-race.js";
import { runRestartPersistence } from "./scenarios/restart-persistence.js";
import { writeReport } from "./reporting/report-writer.js";

dotenv.config({
  path: new URL("../../.env", import.meta.url),
});

async function main() {
  const config = loadConfig();

  const startedAt = new Date().toISOString();
  const results = [];

  let provider;
  let candidate;
  let mongoObserver;
  let candidateClient;
  let providerControl;

  const runIds = {
    duplicate: `run_duplicate_${randomUUID().replaceAll("-", "")}`,
    inventory: `run_inventory_${randomUUID().replaceAll("-", "")}`,
    webhook: `run_webhook_${randomUUID().replaceAll("-", "")}`,
    timeout: `run_timeout_${randomUUID().replaceAll("-", "")}`,
    cancellation: `run_cancellation_payment_race_${randomUUID().replaceAll("-", "")}`,
    persistence: `run_persistence_${randomUUID().replaceAll("-", "")}`,
  };

  const allRunIds = Object.values(runIds);

  try {
    console.log("OrderGuard Eval starting...");

    console.log("Starting Mock Provider...");
    provider = await startProvider(config);
    console.log("Mock Provider is ready.");

    console.log("Starting Candidate...");
    candidate = await startCandidate(config);
    console.log("Candidate is ready.");

    mongoObserver = await createMongoObserver(config);
    candidateClient = createCandidateClient(config);
    providerControl = createProviderControl(config);

    console.log("\nRunning Scenario 1: Duplicate Order Prevention...");

    const result1 = await runDuplicateOrderPrevention({
      config,
      candidateClient,
      providerControl,
      mongoObserver,
      runId: runIds.duplicate,
    });

    console.log("\nScenario 1 result:");
    console.log(JSON.stringify(result1, null, 2));

    results.push(result1);

    console.log("\nRunning Scenario 2: Inventory Race Condition...");

    const result2 = await runInventoryRaceCondition({
      config,
      candidateClient,
      providerControl,
      mongoObserver,
      runId: runIds.inventory,
    });

    console.log("\nScenario 2 result:");
    console.log(JSON.stringify(result2, null, 2));

    results.push(result2);

    console.log("\nRunning Scenario 3: Duplicate Payment Webhook...");

    const result3 = await runDuplicatePaymentWebhook({
      config,
      candidateClient,
      providerControl,
      mongoObserver,
      runId: runIds.webhook,
    });

    console.log("\nScenario 3 result:");
    console.log(JSON.stringify(result3, null, 2));

    results.push(result3);

    console.log("\nRunning Scenario 4: Payment Timeout & Retry...");

    const result4 = await runPaymentTimeoutRetry({
      config,
      candidateClient,
      providerControl,
      mongoObserver,
      runId: runIds.timeout,
    });

    console.log("\nScenario 4 result:");
    console.log(JSON.stringify(result4, null, 2));

    results.push(result4);

    console.log("\nRunning Scenario 5: Cancellation vs Payment Race...");

    const result5 = await runCancellationVsPaymentRace({
      config,
      candidateClient,
      providerControl,
      mongoObserver,
      runId: runIds.cancellation,
    });

    console.log("\nScenario 5 result:");
    console.log(JSON.stringify(result5, null, 2));

    results.push(result5);

    console.log("\nRunning Scenario 6: Persistence After Restart...");

    const result6 = await runRestartPersistence({
      config,
      candidateClient,
      mongoObserver,
      runId: runIds.persistence,
      restartCandidate: async () => {
        await stopCandidate(candidate, config);
        candidate = null;

        candidate = await startCandidate(config);
      },
    });

    console.log("\nScenario 6 result:");
    console.log(JSON.stringify(result6, null, 2));

    results.push(result6);

    const reportResult = await writeReport({
      target: config.candidate.target,
      results,
      runIds,
      startedAt,
      finishedAt: new Date().toISOString(),
    });

    console.log("\nReports generated:");
    console.log("JSON:", reportResult.jsonPath);
    console.log("Markdown:", reportResult.markdownPath);
  } finally {
    console.log("\nCleaning up...");

    if (candidate && candidateClient) {
      for (const runId of allRunIds) {
        try {
          const response = await candidateClient.request({
            method: "DELETE",
            pathname: `/_test/runs/${encodeURIComponent(runId)}`,
            runId,
            headers: {
              "X-Benchmark-Test-Secret": config.candidate.testSecret,
            },
          });

          if (response.status !== 204) {
            console.error(
              `Candidate cleanup returned HTTP ${response.status} for ${runId}`,
            );
          }
        } catch {
          console.error(`Candidate cleanup failed for ${runId}.`);
        }
      }
    }

    if (provider && providerControl) {
      for (const runId of allRunIds) {
        try {
          await providerControl.cleanupRun(runId);
        } catch {
          console.error(`Provider cleanup failed for ${runId}.`);
        }
      }
    }

    if (mongoObserver) {
      await mongoObserver.close();
    }

    if (candidate) {
      await stopCandidate(candidate, config);
    }

    if (provider) {
      await stopProvider(provider, config);
    }

    console.log("Evaluator shutdown complete.");
  }
}

main().catch((error) => {
  console.error(`Evaluator failed: ${error.message}`);
  process.exitCode = 1;
});
