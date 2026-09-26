import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from 'typebox';
import {
  ApiException,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  RbacAuthorizationV1Api,
} from "@kubernetes/client-node";

const DEFAULT_NAMESPACE = "default";
const DEFAULT_IMAGE = "docker.io/mhmxs/pi-agent-empty:latest";
const DEFAULT_SERVICE_ACCOUNT = "pi-agent-worker";
const DEFAULT_ROLE = "pi-agent-worker-role";
const DEFAULT_ROLE_BINDING = "pi-agent-worker-rolebinding";
const DEFAULT_CONFIG_SECRET = "pi-agent-config";
const DEFAULT_AUTH_FILE = join(homedir(), ".pi", "agent", "auth.json");
const DEFAULT_MODELS_STORE_FILE = join(homedir(), ".pi", "agent", "models-store.json");
const DEFAULT_WORKSPACE_HOST_PATH = "/workspace";

function normalizeWorkspaceHostPath(path: string | undefined): string {
  return path?.trim() || DEFAULT_WORKSPACE_HOST_PATH;
}

function isNotFound(err: unknown): boolean {
  return err instanceof ApiException && err.code === 404;
}

function isConflict(err: unknown): boolean {
  return err instanceof ApiException && (err.code === 409 || err.code === 422);
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiException) {
    const body: any = err.body;
    return `${err.code} ${body?.message || err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function ensureServiceAccount(
  core: CoreV1Api,
  namespace: string,
  name: string
): Promise<"created" | "reused"> {
  try {
    await core.readNamespacedServiceAccount({ name, namespace });
    return "reused";
  } catch (err) {
    if (!isNotFound(err)) throw new Error(`failed reading ServiceAccount ${name}: ${errorMessage(err)}`);
  }
  try {
    await core.createNamespacedServiceAccount({
      namespace,
      body: {
        metadata: { name, namespace },
      },
    });
    return "created";
  } catch (err) {
    if (isConflict(err)) return "reused";
    throw new Error(`failed creating ServiceAccount ${name}: ${errorMessage(err)}`);
  }
}

async function ensureRole(
  rbac: RbacAuthorizationV1Api,
  namespace: string,
  name: string
): Promise<"created" | "reused"> {
  try {
    await rbac.readNamespacedRole({ name, namespace });
    return "reused";
  } catch (err) {
    if (!isNotFound(err)) throw new Error(`failed reading Role ${name}: ${errorMessage(err)}`);
  }
  try {
    await rbac.createNamespacedRole({
      namespace,
      body: {
        metadata: { name, namespace },
        rules: [
          {
            apiGroups: ["batch"],
            resources: ["jobs"],
            verbs: ["get", "list", "watch"],
          },
          {
            apiGroups: [""],
            resources: ["pods", "pods/log"],
            verbs: ["get", "list", "watch"],
          },
        ],
      },
    });
    return "created";
  } catch (err) {
    if (isConflict(err)) return "reused";
    throw new Error(`failed creating Role ${name}: ${errorMessage(err)}`);
  }
}

async function ensureRoleBinding(
  rbac: RbacAuthorizationV1Api,
  namespace: string,
  name: string,
  roleName: string,
  serviceAccountName: string
): Promise<"created" | "reused"> {
  try {
    await rbac.readNamespacedRoleBinding({ name, namespace });
    return "reused";
  } catch (err) {
    if (!isNotFound(err)) throw new Error(`failed reading RoleBinding ${name}: ${errorMessage(err)}`);
  }
  try {
    await rbac.createNamespacedRoleBinding({
      namespace,
      body: {
        metadata: { name, namespace },
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "Role",
          name: roleName,
        },
        subjects: [
          {
            kind: "ServiceAccount",
            name: serviceAccountName,
            namespace,
          },
        ],
      },
    });
    return "created";
  } catch (err) {
    if (isConflict(err)) return "reused";
    throw new Error(`failed creating RoleBinding ${name}: ${errorMessage(err)}`);
  }
}

async function readLocalFileSafe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return undefined;
    throw err;
  }
}

async function ensureConfigSecret(
  core: CoreV1Api,
  namespace: string,
  name: string,
  authFilePath: string,
  modelsStoreFilePath: string
): Promise<"created" | "reused"> {
  try {
    await core.readNamespacedSecret({ name, namespace });
    return "reused";
  } catch (err) {
    if (!isNotFound(err)) throw new Error(`failed reading Secret ${name}: ${errorMessage(err)}`);
  }

  const [authContents, modelsStoreContents] = await Promise.all([
    readLocalFileSafe(authFilePath),
    readLocalFileSafe(modelsStoreFilePath),
  ]);

  const stringData: Record<string, string> = {};
  if (authContents !== undefined) stringData["auth.json"] = authContents;
  if (modelsStoreContents !== undefined) stringData["models-store.json"] = modelsStoreContents;

  try {
    await core.createNamespacedSecret({
      namespace,
      body: {
        metadata: { name, namespace },
        type: "Opaque",
        stringData,
      },
    });
    return "created";
  } catch (err) {
    if (isConflict(err)) return "reused";
    throw new Error(`failed creating Secret ${name}: ${errorMessage(err)}`);
  }
}

function buildWorkerArgs(
  workerPrompt: string,
  provider: string | undefined,
  model: string | undefined
): string[] {
  const args = [
    "--mode",
    "json"
  ];
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  args.push("-p", workerPrompt);
  return args;
}

export default function registerCreateKubernetesJob(pi: any) {
  pi.registerTool({
    name: "create_kubernetes_job",
    label: "Create Kubernetes Job",
    description:
      "Create a single worker Kubernetes Job that runs the pi agent with a given prompt. " +
      "Ensures the bootstrap ServiceAccount, Role, RoleBinding, and pi-agent-config Secret " +
      "exist in the target namespace before creating the Job.",
    parameters: Type.Object({
      jobName: Type.String({ description: "Name of the Job to create." }),
      workerPrompt: Type.String({ description: "Prompt passed to the worker pi agent via -p." }),
      namespace: Type.Optional(Type.String({ description: `Target namespace. Default: ${DEFAULT_NAMESPACE}.` })),
      workspaceHostPath: Type.Optional(
        Type.String({ description: `Host path mounted at /workspace. Default: ${DEFAULT_WORKSPACE_HOST_PATH}.` })
      ),
      image: Type.Optional(Type.String({ description: `Worker container image. Default: ${DEFAULT_IMAGE}.` })),
      serviceAccountName: Type.Optional(
        Type.String({ description: `Bootstrap ServiceAccount name. Default: ${DEFAULT_SERVICE_ACCOUNT}.` })
      ),
      roleName: Type.Optional(Type.String({ description: `Bootstrap Role name. Default: ${DEFAULT_ROLE}.` })),
      roleBindingName: Type.Optional(
        Type.String({ description: `Bootstrap RoleBinding name. Default: ${DEFAULT_ROLE_BINDING}.` })
      ),
      configSecretName: Type.Optional(
        Type.String({ description: `Secret name for auth/models-store config. Default: ${DEFAULT_CONFIG_SECRET}.` })
      ),
      authFilePath: Type.Optional(
        Type.String({ description: `Local path to auth.json used to populate the config Secret. Default: ${DEFAULT_AUTH_FILE}.` })
      ),
      modelsStoreFilePath: Type.Optional(
        Type.String({
          description: `Local path to models-store.json used to populate the config Secret. Default: ${DEFAULT_MODELS_STORE_FILE}.`,
        })
      ),
      provider: Type.Optional(Type.String({ description: "Optional --provider flag passed to the worker pi CLI." })),
      model: Type.Optional(Type.String({ description: "Optional --model flag passed to the worker pi CLI." })),
    }),

    async execute(_toolCallId, params) {
      const namespace = params.namespace || DEFAULT_NAMESPACE;
      const image = params.image || DEFAULT_IMAGE;
      const workspaceHostPath = normalizeWorkspaceHostPath(params.workspaceHostPath);
      const serviceAccountName = params.serviceAccountName || DEFAULT_SERVICE_ACCOUNT;
      const roleName = params.roleName || DEFAULT_ROLE;
      const roleBindingName = params.roleBindingName || DEFAULT_ROLE_BINDING;
      const configSecretName = params.configSecretName || DEFAULT_CONFIG_SECRET;
      const authFilePath = params.authFilePath || DEFAULT_AUTH_FILE;
      const modelsStoreFilePath = params.modelsStoreFilePath || DEFAULT_MODELS_STORE_FILE;

      const bootstrap: Record<string, "created" | "reused"> = {};

      try {
        const kc = new KubeConfig();
        kc.loadFromDefault();

        const core = kc.makeApiClient(CoreV1Api);
        const rbac = kc.makeApiClient(RbacAuthorizationV1Api);
        const batch = kc.makeApiClient(BatchV1Api);

        bootstrap.serviceAccount = await ensureServiceAccount(core, namespace, serviceAccountName);
        bootstrap.role = await ensureRole(rbac, namespace, roleName);
        bootstrap.roleBinding = await ensureRoleBinding(
          rbac,
          namespace,
          roleBindingName,
          roleName,
          serviceAccountName
        );
        bootstrap.configSecret = await ensureConfigSecret(
          core,
          namespace,
          configSecretName,
          authFilePath,
          modelsStoreFilePath
        );

        const args = buildWorkerArgs(params.workerPrompt, params.provider, params.model);

        const job = await batch.createNamespacedJob({
          namespace,
          body: {
            metadata: {
              name: params.jobName,
              namespace,
            },
            spec: {
              backoffLimit: 3,
              activeDeadlineSeconds: 1800,
              ttlSecondsAfterFinished: 600,
              template: {
                metadata: {
                  labels: { app: "pi-agent-worker", job: params.jobName },
                },
                spec: {
                  serviceAccountName,
                  restartPolicy: "Never",
                  containers: [
                    {
                      name: "pi-agent-worker",
                      image,
                      workingDir: "/workspace",
                      command: ["pi"],
                      args,
                      env: [{ name: "PI_ENVIRONMENT", value: "production" }],
                      resources: {
                        requests: { cpu: "100m", memory: "256Mi" },
                        limits: { cpu: "500m", memory: "512Mi" },
                      },
                      volumeMounts: [
                        { name: "workspace", mountPath: "/workspace" },
                        {
                          name: "pi-agent-config",
                          mountPath: "/root/.pi/agent/auth.json",
                          subPath: "auth.json",
                          readOnly: true,
                        },
                        {
                          name: "pi-agent-config",
                          mountPath: "/root/.pi/agent/models-store.json",
                          subPath: "models-store.json",
                          readOnly: true,
                        },
                      ],
                    },
                  ],
                  volumes: [
                    { name: "workspace", hostPath: { path: workspaceHostPath, type: "DirectoryOrCreate" } },
                    { name: "pi-agent-config", secret: { secretName: configSecretName } },
                  ],
                },
              },
            },
          },
        });

        const result = {
          status: "success",
          namespace,
          jobName: job.metadata?.name || params.jobName,
          bootstrap,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      } catch (err) {
        const result = {
          status: "error",
          namespace,
          jobName: params.jobName,
          bootstrap,
          error: errorMessage(err),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
          isError: true,
        };
      }
    },
  });
}
