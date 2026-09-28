import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { Type } from 'typebox';
import { CoreApi, KubeConfig } from '@kubernetes/client-node';
import * as memlib from './agent-memory-lib.mjs';

const DEFAULT_NAMESPACE_PATH = process.env.NS_PATH || '/var/run/secrets/kubernetes.io/serviceaccount/namespace';
const MEMORY_NAMESPACE = process.env.MEMORY_NAMESPACE || 'default';
const MEMORY_DECISION_URL = process.env.MEMORY_DECISION_URL || '';
const MEMORY_DECISION_TOKEN = process.env.MEMORY_DECISION_TOKEN || '';

function readNamespace() {
  try {
    return fs.readFileSync(DEFAULT_NAMESPACE_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

function shortId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
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

  if (isHttps) {
    // attempt to use in-cluster TLS settings via KubeConfig when available
    // (best-effort; not required for the external decision endpoint)
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

      const MEMORY_DIR = '/root/.pi/agent/memories';
      try { fs.mkdirSync(MEMORY_DIR, { recursive: true }); } catch {}
      const catalogPath = path.join(MEMORY_DIR, 'catalog.json');

      // read or initialize catalog file
      let categories: string[] = [];
      try {
        const raw = fs.readFileSync(catalogPath, 'utf8');
        categories = JSON.parse(raw);
        if (!Array.isArray(categories)) categories = [];
      } catch {
        categories = [];
        try { fs.writeFileSync(catalogPath, JSON.stringify(categories), 'utf8'); } catch {}
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

      // add category to catalog if new
      if (!categories.includes(category)) {
        categories.push(category);
        try { fs.writeFileSync(catalogPath, JSON.stringify(categories), 'utf8'); } catch {}
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
      const maxBytes = 800 * 1024;

      async function appendToFileName(nameToUse: string) {
        const filename = path.join(MEMORY_DIR, `${nameToUse}.json`);
        try {
          let arr: any[] = [];
          try {
            const raw = fs.readFileSync(filename, 'utf8');
            arr = JSON.parse(raw);
            if (!Array.isArray(arr)) arr = [];
          } catch {
            arr = [];
          }
          arr.push(record);
          const serialized = JSON.stringify(arr);
          if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
            return { overflow: true };
          }
          fs.writeFileSync(filename, serialized, 'utf8');
          return { ok: true };
        } catch (e: any) {
          throw e;
        }
      }

      // try append to base name, if overflow create/use -v2
      try {
        const res = await appendToFileName(baseName);
        if (res && (res as any).overflow) {
          const v2 = `${baseName}-v2`;
          const res2 = await appendToFileName(v2);
          return {
            content: [{ type: 'text', text: JSON.stringify({ status: 'ok', id: record.id, storedIn: v2, category, bucket }, null, 2) }],
            details: { status: 'ok', id: record.id, storedIn: v2, category, bucket }
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'ok', id: record.id, storedIn: baseName, category, bucket }, null, 2) }],
          details: { status: 'ok', id: record.id, storedIn: baseName, category, bucket }
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

      const MEMORY_DIR = '/root/.pi/agent/memories';
      try { fs.mkdirSync(MEMORY_DIR, { recursive: true }); } catch {}
      const catalogPath = path.join(MEMORY_DIR, 'catalog.json');

      // read catalog
      let categories: string[] = [];
      try {
        const raw = fs.readFileSync(catalogPath, 'utf8');
        categories = JSON.parse(raw);
        if (!Array.isArray(categories)) categories = [];
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

      // find matching files for category + buckets
      try {
        const encodedBuckets = buckets.map(String).map(b => b.trim()).filter(Boolean);
        const bases = encodedBuckets.map(b => memlib.bucketConfigMapName(category, b));
        const items: string[] = [];
        try { const files = fs.readdirSync(MEMORY_DIR); for (const f of files) { if (!f.endsWith('.json')) continue; if (f === 'catalog.json') continue; const nameNoExt = f.slice(0, -5); if (bases.some(b => nameNoExt === b || nameNoExt.startsWith(`${b}-`))) items.push(path.join(MEMORY_DIR, f)); } } catch {}

        const allRecords: any[] = [];
        for (const filePath of items) {
          try {
            const raw = fs.readFileSync(filePath, 'utf8') || '[]';
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) allRecords.push(parsed);
          } catch {
            // skip bad files
          }
        }

        // merge using helper
        const merged = memlib.mergeMemories(...allRecords);
        return {
          content: [{ type: 'text', text: JSON.stringify(merged, null, 2) }],
          details: { status: 'ok', count: merged.length, memories: merged }
        };
      } catch (e: any) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'failed to list or parse memory files', error: String(e?.message || e) }, null, 2) }],
          details: { status: 'error', message: 'failed to list or parse memory files', error: String(e?.message || e) }
        };
      }
    }
  });
}
