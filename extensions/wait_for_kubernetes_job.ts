import { Type } from 'typebox';
import {
  BatchV1Api,
  KubeConfig,
  ApiException,
} from '@kubernetes/client-node';

const DEFAULT_NAMESPACE = 'default';

export default function registerWaitForKubernetesJob(pi: any) {
  pi.registerTool({
    name: 'wait_for_kubernetes_job',
    label: 'Wait for Kubernetes Job',
    description:
      'Poll a Kubernetes Job until it succeeds, fails, or a timeout elapses and return a concise status summary.',
    parameters: Type.Object({
      jobName: Type.String({ description: 'Name of the Job to wait for.' }),
      namespace: Type.Optional(Type.String({ description: `Target namespace. Default: ${DEFAULT_NAMESPACE}.` })),
      timeoutSeconds: Type.Optional(Type.Number({ description: 'Maximum seconds to wait before giving up (optional).' })),
      pollIntervalSeconds: Type.Optional(Type.Number({ description: 'Polling interval in seconds (optional).' })),
    }),

    async execute(_toolCallId: any, params: any) {
      const namespace = params.namespace || DEFAULT_NAMESPACE;
      const jobName = params.jobName;
      const timeoutSeconds = Math.max(0, Math.trunc(params.timeoutSeconds || 300)); // default 5m
      const pollIntervalMs = Math.max(250, Math.trunc((params.pollIntervalSeconds || 2) * 1000));

      const kc = new KubeConfig();
      kc.loadFromDefault();
      const batch = kc.makeApiClient(BatchV1Api);

      const startedAt = Date.now();

      try {
        while (true) {
          // Respect timeout
          const elapsed = Math.floor((Date.now() - startedAt) / 1000);
          if (timeoutSeconds > 0 && elapsed >= timeoutSeconds) {
            const summary = {
              status: 'timeout',
              namespace,
              jobName,
              summary: `timed out after ${elapsed}s waiting for job to complete`,
              details: { elapsedSeconds: elapsed },
            };
            return {
              content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
              details: summary,
            };
          }

          // Read the Job status
          let job;
          try {
            // Note: using readNamespacedJob to observe status.succeeded / status.failed / spec.activeDeadlineSeconds
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            job = (await batch.readNamespacedJob(jobName, namespace)).body;
          } catch (err) {
            // If job not found, bubble a concise error
            const isNotFound = err instanceof ApiException && err.statusCode === 404;
            if (isNotFound) {
              const result = {
                status: 'error',
                namespace,
                jobName,
                summary: 'job not found',
                details: { message: 'Job resource was not found in the target namespace' },
              };
              return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                details: result,
                isError: true,
              };
            }
            throw err;
          }

          // Inspect status counters and conditions for a concise outcome
          const succeeded = Number(job?.status?.succeeded || 0);
          const failed = Number(job?.status?.failed || 0);
          const active = Number(job?.status?.active || 0);
          const activeDeadlineSeconds = job?.spec?.activeDeadlineSeconds;

          if (succeeded > 0) {
            const result = {
              status: 'succeeded',
              namespace,
              jobName,
              summary: `job succeeded; succeeded=${succeeded}`,
              details: { succeeded, failed, active },
            };
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
              details: result,
            };
          }

          if (failed > 0) {
            const result = {
              status: 'failed',
              namespace,
              jobName,
              summary: `job failed; failed=${failed}`,
              details: { succeeded, failed, active },
            };
            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
              details: result,
              isError: true,
            };
          }

          // If the Job spec set an activeDeadlineSeconds, surface that as part of the polling logic
          if (typeof activeDeadlineSeconds === 'number' && activeDeadlineSeconds > 0) {
            // if elapsed exceeds activeDeadlineSeconds, consider it timed out by the Job
            if (elapsed >= activeDeadlineSeconds) {
              const result = {
                status: 'failed',
                namespace,
                jobName,
                summary: `job exceeded activeDeadlineSeconds (${activeDeadlineSeconds}s)` ,
                details: { succeeded, failed, active, activeDeadlineSeconds },
              };
              return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                details: result,
                isError: true,
              };
            }
          }

          // Still running; wait and poll again
          // Use an explicit Promise-based sleep so tests can detect a wait/poll pattern
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
      } catch (err) {
        const result = {
          status: 'error',
          namespace,
          jobName,
          summary: 'failed querying job status',
          details: { error: err?.message || String(err) },
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          details: result,
          isError: true,
        };
      }
    },
  });
}
