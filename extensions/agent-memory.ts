import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Type } from 'typebox';
import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import * as memlib from './agent-memory-lib.mjs';

const DEFAULT_NAMESPACE_PATH = process.env.NS_PATH || '/var/run/secrets/kubernetes.io/serviceaccount/namespace';
const MEMORY_NAMESPACE_ENV = process.env.MEMORY_NAMESPACE || '';
const MEMORY_DECISION_URL = process.env.MEMORY_DECISION_URL || '';
const MEMORY_DECISION_TOKEN = process.env.MEMORY_DECISION_TOKEN || '';

function readNamespace() {
  try {
    return fs.readFileSync(DEFAULT_NAMESPACE_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

function resolveNamespace() {
  // Priority: explicit env var -> in-cluster pod namespace file -> default
  return MEMORY_NAMESPACE_ENV || readNamespace() || 'default';
}

function shortId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function getCoreClient() {
  const kc = new KubeConfig();
  try {
    kc.loadFromDefault();
  } catch {}
  return kc.makeApiClient(CoreV1Api);
}

const CATALOG_CONFIGMAP = 'pi-agent-memory-catalog';
const MAX_CONFIGMAP_BYTES = 800 * 1024; // conservative limit for ConfigMap data

async function readCatalogConfigMap(core: any, namespace: string): Promise<string[]> {
  try {
    const res: any = await core.readNamespacedConfigMap({ name: CATALOG_CONFIGMAP, namespace });
    const raw = (res?.body?.data && res.body.data.catalog) || (res?.body?.data && res.body.data.CATALOG) || undefined;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e: any) {
    return [];
  }
}

async function writeCatalogConfigMap(core: any, namespace: string, categories: string[]) {
  const body = { metadata: { name: CATALOG_CONFIGMAP, namespace }, data: { catalog: JSON.stringify(categories) } };
  try {
    await core.replaceNamespacedConfigMap({ name: CATALOG_CONFIGMAP, namespace, body });
  } catch (e: any) {
    try {
      await core.createNamespacedConfigMap({ namespace, body });
    } catch (err: any) {
      // best-effort; ignore failures
    }
  }
}

async function appendToBucketConfigMap(core: any, namespace: string, baseName: string, record: any) {
  async function tryAppend(nameToUse: string) {
    try {
      const res: any = await core.readNamespacedConfigMap({ name: nameToUse, namespace });
      const existingRaw = (res?.body?.data && (res.body.data.memories || res.body.data.MEMORIES)) || '[]';
      let arr = [];
      try { arr = JSON.parse(existingRaw); if (!Array.isArray(arr)) arr = []; } catch { arr = []; }
      arr.push(record);
      const serialized = JSON.stringify(arr);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_CONFIGMAP_BYTES) return { overflow: true };
      const body = { metadata: { name: nameToUse, namespace }, data: { memories: serialized } };
      try {
        await core.replaceNamespacedConfigMap({ name: nameToUse, namespace, body });
      } catch {
        try { await core.createNamespacedConfigMap({ namespace, body }); } catch {}
      }
      return { ok: true };
    } catch (e: any) {
      // not found -> create
      const arr = [record];
      const serialized = JSON.stringify(arr);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_CONFIGMAP_BYTES) return { overflow: true };
      const body = { metadata: { name: nameToUse, namespace }, data: { memories: serialized } };
      try { await core.createNamespacedConfigMap({ namespace, body }); return { ok: true }; } catch (err: any) { throw err; }
    }
  }

  // try base then -v2, -v3 ...
  const variants = [baseName, `${baseName}-v2`, `${baseName}-v3`, `${baseName}-v4`, `${baseName}-v5`];
  for (const v of variants) {
    const res = await tryAppend(v);
    if (res && (res as any).overflow) continue;
    return res;
  }
  return { overflow: true };
}

async function callDecisionEndpoint(payload: any) {
  if (!MEMORY_DECISION_URL) throw new Error('MEMORY_DECISION_URL is not configured');
  const url = new URL(MEMORY_DECISION_URL);
  const isHttps = url.protocol === 'https:';
  const body = JSON.stringify(payload);
  const options: https.RequestOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body, 'utf8'),
      Accept: 'application/json'
    }
  };
  if (MEMORY_DECISION_TOKEN) {
    options.headers = { ...(options.headers || {}), Authorization: `Bearer ${MEMORY_DECISION_TOKEN}` };
  }

  const client = isHttps ? https : http;

  return await new Promise<any>((resolve, reject) => {
    const req = client.request(url, options, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (raw += chunk));
      res.on('end', () => {
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) {
          reject(new Error(`decision endpoint ${MEMORY_DECISION_URL} failed with status ${status}: ${raw.slice(0, 400)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e: any) {
          reject(new Error(`decision endpoint returned invalid JSON: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function ensureString(v: any) {
  return typeof v === 'string' ? v : '';
}

export default function registerAgentMemory(pi: any) {
  pi.registerTool({
    name: 'save_memory',
    label: 'save_memory',
    description: 'Persist a memory record into a file-backed catalog and bucket store under /root/.pi/agent/memories.',
    parameters: Type.Object({
      problem: Type.String({ description: 'Short problem summary' }),
      findings: Type.Optional(Type.Array(Type.String())),
      summary: Type.String({ description: 'Short summary to store' })
    }),
    async execute(_toolCallId: any, params: any) {
      if (!MEMORY_DECISION_URL) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'MEMORY_DECISION_URL is not set' }, null, 2) }],
          details: { status: 'error', message: 'MEMORY_DECISION_URL is not set' }
        };
      }

      const namespace = resolveNamespace();
      const core = getCoreClient();

      // read or initialize catalog (ConfigMap-backed)
      let categories: string[] = [];
      try {
        categories = await readCatalogConfigMap(core, namespace);
      } catch {
        categories = [];
      }

      // build memory text for decision
      const textParts = [ensureString(params.problem)];
      if (Array.isArray(params.findings) && params.findings.length) textParts.push(params.findings.join('\n'));
      if (params.summary) textParts.push(ensureString(params.summary));
      const decisionPayload = { text: textParts.join('\n\n'), categories };

      let decision: any;
      try {
        decision = await callDecisionEndpoint(decisionPayload);
      } catch (e: any) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'decision endpoint failed', error: String(e?.message || e) }, null, 2) }],
          details: { status: 'error', message: 'decision endpoint failed', error: String(e?.message || e) }
        };
      }

      const category = String(decision?.category || '').trim();
      const bucket = String(decision?.bucket || '').trim();
      if (!category || !bucket) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'decision endpoint returned invalid category or bucket', decision }, null, 2) }],
          details: { status: 'error', message: 'decision endpoint returned invalid category or bucket', decision }
        };
      }

      // add category to catalog if new (ConfigMap-backed)
      if (!categories.includes(category)) {
        categories.push(category);
        try { await writeCatalogConfigMap(core, namespace, categories); } catch {}
      }

      // prepare memory record
      const record = {
        id: shortId(),
        timestamp: new Date().toISOString(),
        category,
        bucket,
        problem: ensureString(params.problem),
        findings: Array.isArray(params.findings) ? params.findings : [],
        summary: ensureString(params.summary)
      };

      const baseName = memlib.bucketConfigMapName(category, bucket);

      try {
        const res = await appendToBucketConfigMap(core, namespace, baseName, record);
        if (res && (res as any).overflow) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'memory exceeds ConfigMap storage limits' }, null, 2) }],
            details: { status: 'error', message: 'memory exceeds ConfigMap storage limits' }
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'ok', id: record.id, storedIn: baseName, category, bucket }, null, 2) }],
          details: { status: 'ok', id: record.id, storedIn: baseName, category, bucket, note: 'saves are eventually consistent; use only save_memory/query_memory and do not rely on ConfigMap layout' }
        };
      } catch (e: any) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'failed to persist memory', error: String(e?.message || e) }, null, 2) }],
          details: { status: 'error', message: 'failed to persist memory', error: String(e?.message || e) }
        };
      }
    }
  });

  pi.registerTool({
    name: 'query_memory',
    label: 'query_memory',
    description: 'Query memory records from a file-backed catalog and bucket store by delegating to the decision endpoint for category/bucket selection and merging found records.',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' })
    }),
    async execute(_toolCallId: any, params: any) {
      if (!MEMORY_DECISION_URL) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'MEMORY_DECISION_URL is not set' }, null, 2) }],
          details: { status: 'error', message: 'MEMORY_DECISION_URL is not set' }
        };
      }

      const namespace = resolveNamespace();
      const core = getCoreClient();

      // read catalog (ConfigMap-backed)
      let categories: string[] = [];
      try {
        categories = await readCatalogConfigMap(core, namespace);
      } catch {
        categories = [];
      }

      // call decision endpoint with query + catalog
      let decision: any;
      try {
        decision = await callDecisionEndpoint({ text: ensureString(params.query), categories });
      } catch (e: any) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'decision endpoint failed', error: String(e?.message || e) }, null, 2) }],
          details: { status: 'error', message: 'decision endpoint failed', error: String(e?.message || e) }
        };
      }

      const category = String(decision?.category || '').trim();
      let buckets = decision?.buckets;
      if (!category) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'decision endpoint returned no category', decision }, null, 2) }],
          details: { status: 'error', message: 'decision endpoint returned no category', decision }
        };
      }

      if (!buckets) {
        buckets = memlib.BUCKETS;
      } else if (typeof buckets === 'string') {
        buckets = [buckets];
      } else if (!Array.isArray(buckets)) {
        buckets = memlib.BUCKETS;
      }

      // find matching ConfigMaps for category + buckets
      try {
        const encodedBuckets = buckets.map(String).map(b => b.trim()).filter(Boolean);
        const bases = encodedBuckets.map(b => memlib.bucketConfigMapName(category, b));

        const allRecords: any[] = [];
        for (const base of bases) {
          const variants = [base, `${base}-v2`, `${base}-v3`, `${base}-v4`, `${base}-v5`];
          for (const name of variants) {
            try {
              const res: any = await core.readNamespacedConfigMap({ name, namespace });
              const raw = (res?.body?.data && (res.body.data.memories || res.body.data.MEMORIES)) || '[]';
              try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) allRecords.push(parsed);
              } catch {
                // skip bad
              }
            } catch {
              // not found - skip
            }
          }
        }

        const merged = memlib.mergeMemories(...allRecords);
        return {
          content: [{ type: 'text', text: JSON.stringify(merged, null, 2) }],
          details: { status: 'ok', count: merged.length, memories: merged, note: 'results are eventually consistent; use only save_memory/query_memory and do not rely on ConfigMap layout' }
        };
      } catch (e: any) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'failed to list or parse memory ConfigMaps', error: String(e?.message || e) }, null, 2) }],
          details: { status: 'error', message: 'failed to list or parse memory ConfigMaps', error: String(e?.message || e) }
        };
      }
    }
  });
}
