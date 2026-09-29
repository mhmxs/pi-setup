import test from 'node:test';
import assert from 'node:assert/strict';

// Recreate the minimal filtering logic from kubernetes-service-discovery.ts
// so this test can run under plain node without importing the .ts source.
const SERVICE_EXPOSURE_KINDS = new Set([
  'Service',
  'Ingress',
  'Gateway',
  'GatewayClass',
  'HTTPRoute',
  'GRPCRoute',
  'TCPRoute',
  'UDPRoute',
  'TLSRoute',
  'Route',
  'APIService',
  'ServiceExport',
  'ServiceImport',
  'VirtualService',
  'ServiceEntry',
  'DestinationRule',
  'DomainMapping',
  'ServerlessService'
]);

function classifyResource(resource, groupVersion) {
  const categories = new Set();
  const kind = String(resource?.kind || '');
  const name = String(resource?.name || '');
  const lower = `${groupVersion} ${kind} ${name}`.toLowerCase();

  if (groupVersion === 'v1' && (kind === 'Service' || name === 'services')) {
    categories.add('core-service');
  }
  if (kind === 'Endpoints' || kind === 'EndpointSlice' || /endpoint/.test(lower)) {
    categories.add('service-discovery-data');
  }
  if (['Ingress', 'Gateway', 'GatewayClass', 'HTTPRoute', 'GRPCRoute', 'TCPRoute', 'UDPRoute', 'TLSRoute', 'Route'].includes(kind)) {
    categories.add('traffic-entrypoint');
  }
  if (/serving\.knative\.dev/.test(lower) || ['DomainMapping', 'ServerlessService'].includes(kind)) {
    categories.add('serverless-serving');
  }
  if (/istio\.io/.test(lower) || ['VirtualService', 'ServiceEntry', 'DestinationRule'].includes(kind)) {
    categories.add('service-mesh');
  }
  if (kind === 'APIService' || kind === 'ServiceExport' || kind === 'ServiceImport') {
    categories.add('cluster-service-integration');
  }

  return Array.from(categories);
}

function isServiceLikeResource(resource, groupVersion) {
  const categories = classifyResource(resource, groupVersion);
  const kind = String(resource?.kind || '');
  const name = String(resource?.name || '');

  if (categories.length > 0) return true;
  if (SERVICE_EXPOSURE_KINDS.has(kind)) return true;

  const lowerCombined = `${kind} ${name} ${groupVersion}`.toLowerCase();
  if (/\b(service|services)\b/.test(lowerCombined)) return true;

  const singular = String(resource?.singularName || '').toLowerCase();
  if (singular === 'service') return true;

  const shortNames = Array.isArray(resource?.shortNames) ? resource.shortNames.map(s => String(s).toLowerCase()) : [];
  if (shortNames.includes('svc') || shortNames.includes('service') || shortNames.includes('services')) return true;

  return false;
}

// True positives
test('Service is recognized as service-like and classified as core-service', () => {
  const svc = { kind: 'Service', name: 'services' };
  assert.equal(isServiceLikeResource(svc, 'v1'), true);
  const cats = classifyResource(svc, 'v1');
  assert.equal(cats.includes('core-service'), true);
});

test('HTTPRoute is recognized as a traffic-entrypoint (service-like)', () => {
  const httpRoute = { kind: 'HTTPRoute', name: 'httproutes' };
  assert.equal(isServiceLikeResource(httpRoute, 'gateway.networking.k8s.io/v1beta1'), true);
  const cats = classifyResource(httpRoute, 'gateway.networking.k8s.io/v1beta1');
  assert.equal(cats.includes('traffic-entrypoint'), true);
});

// False positives that used to match on a naive substring should be excluded
test('ServiceAccount is NOT considered service-like', () => {
  const sa = { kind: 'ServiceAccount', name: 'serviceaccounts', singularName: 'serviceaccount', shortNames: ['sa'] };
  assert.equal(isServiceLikeResource(sa, 'v1'), false);
  assert.deepEqual(classifyResource(sa, 'v1'), []);
});

test('ServiceMonitor (prometheus) is NOT considered service-like by default', () => {
  const sm = { kind: 'ServiceMonitor', name: 'servicemonitors', singularName: 'servicemonitor', shortNames: ['sm'] };
  assert.equal(isServiceLikeResource(sm, 'monitoring.coreos.com/v1'), false);
  assert.deepEqual(classifyResource(sm, 'monitoring.coreos.com/v1'), []);
});

// Sanity check: shortNames containing "svc" still triggers a positive
test('A CRD advertising shortName "svc" is considered service-like via shortNames hint', () => {
  const crd = { kind: 'Thing', name: 'things', shortNames: ['svc'] };
  assert.equal(isServiceLikeResource(crd, 'example.com/v1'), true);
});

// --- Additional regression tests for available-services discovery ---

// Emulate the discovery pipeline: exclude subresources (resource name containing '/'),
// keep only service-like resources, then sort deterministically by kind then groupVersion.
function discoverAvailableServices(resources) {
  return resources
    .filter(r => {
      const name = String(r?.name || '');
      if (name.includes('/')) return false; // exclude subresources
      return isServiceLikeResource(r, r.groupVersion || '');
    })
    .map(r => ({ kind: r.kind, groupVersion: r.groupVersion, name: r.name }))
    .sort((a, b) => {
      const kindCmp = String(a.kind).localeCompare(String(b.kind));
      if (kindCmp !== 0) return kindCmp;
      return String(a.groupVersion || '').localeCompare(String(b.groupVersion || ''));
    });
}

test('subresources (resource name with "/") are excluded from discovery even if service-like', () => {
  const resources = [
    { kind: 'Service', name: 'services/status', groupVersion: 'v1' },
    { kind: 'Service', name: 'services', groupVersion: 'v1' }
  ];
  const discovered = discoverAvailableServices(resources);
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].name, 'services');
});

test('only service-like resources are retained by discovery', () => {
  const resources = [
    { kind: 'Service', name: 'services', groupVersion: 'v1' },
    { kind: 'ServiceAccount', name: 'serviceaccounts', groupVersion: 'v1' },
    { kind: 'ServiceMonitor', name: 'servicemonitors', groupVersion: 'monitoring.coreos.com/v1' },
    { kind: 'VirtualService', name: 'virtualservices', groupVersion: 'networking.istio.io/v1alpha3' }
  ];
  const discovered = discoverAvailableServices(resources);
  const kinds = discovered.map(r => r.kind);
  // Should only keep Service and VirtualService, sorted by kind
  assert.deepEqual(kinds, ['Service', 'VirtualService']);
});

test('discovered services are deterministically sorted by kind then groupVersion', () => {
  const resources = [
    { kind: 'VirtualService', name: 'virtualservices', groupVersion: 'networking.istio.io/v1alpha3' },
    { kind: 'Service', name: 'services', groupVersion: 'v1' },
    { kind: 'APIService', name: 'apiservices', groupVersion: 'apiregistration.k8s.io/v1' },
    { kind: 'Gateway', name: 'gateways', groupVersion: 'gateway.networking.k8s.io/v1beta1' }
  ];
  // shuffle order intentionally
  const shuffled = [resources[2], resources[0], resources[3], resources[1]];
  const discovered = discoverAvailableServices(shuffled);
  const expectedOrder = [
    { kind: 'APIService', groupVersion: 'apiregistration.k8s.io/v1' },
    { kind: 'Gateway', groupVersion: 'gateway.networking.k8s.io/v1beta1' },
    { kind: 'Service', groupVersion: 'v1' },
    { kind: 'VirtualService', groupVersion: 'networking.istio.io/v1alpha3' }
  ];
  assert.deepEqual(discovered.map(r => ({ kind: r.kind, groupVersion: r.groupVersion })), expectedOrder);
});

// --- Unified lookup: combine APIService entries, CRD-backed resources, and discovered service-like resources,
// then rank once and cap to 20 results. This models the user-facing contract for option (a).

function unifyCandidatesFromSources(...sources) {
  const all = [];
  for (const src of sources) {
    for (const r of src || []) {
      all.push({
        kind: r.kind,
        groupVersion: r.groupVersion || r.group || '',
        name: r.name,
        source: r.source || 'discovery'
      });
    }
  }
  // dedupe by kind|groupVersion|name
  const seen = new Set();
  const deduped = [];
  for (const c of all) {
    const key = `${c.kind}|${c.groupVersion}|${c.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }
  return deduped;
}

function scoreCandidate(query, c) {
  // deterministic single-pass scoring: higher is better
  const q = String(query || '').toLowerCase();
  const kind = String(c.kind || '').toLowerCase();
  const name = String(c.name || '').toLowerCase();
  const gv = String(c.groupVersion || '').toLowerCase();

  if (!q) return 0;
  let score = 0;
  // exact name match is best
  if (name === q) score += 1000;
  // exact kind match next
  if (kind === q) score += 500;
  // prefix matches are better than substring
  if (name.startsWith(q) || kind.startsWith(q) || gv.startsWith(q)) score += 100;
  // substring matches
  if (name.includes(q) || kind.includes(q) || gv.includes(q)) score += 10;
  // prefer core Service kind higher
  if (c.kind === 'Service') score += 5;
  return score;
}

function unifiedLookup(query, { apiServices = [], crdResources = [], discovered = [] } = {}) {
  const combined = unifyCandidatesFromSources(apiServices, crdResources, discovered);
  // single ranking pass: compute scores then sort deterministically
  const scored = combined.map(c => ({
    candidate: c,
    score: scoreCandidate(query, c)
  }));

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    // tie-breaker deterministic: kind, groupVersion, name, source
    const ka = String(a.candidate.kind || '');
    const kb = String(b.candidate.kind || '');
    const kcmp = ka.localeCompare(kb);
    if (kcmp !== 0) return kcmp;
    const gcmp = String(a.candidate.groupVersion || '').localeCompare(String(b.candidate.groupVersion || ''));
    if (gcmp !== 0) return gcmp;
    const ncmp = String(a.candidate.name || '').localeCompare(String(b.candidate.name || ''));
    if (ncmp !== 0) return ncmp;
    return String(a.candidate.source || '').localeCompare(String(b.candidate.source || ''));
  });

  // cap to 20 results
  return scored.slice(0, 20).map(s => s.candidate);
}

test('unified lookup combines sources, dedupes, ranks deterministically for a query', () => {
  const apiServices = [
    { kind: 'APIService', name: 'apiservices', groupVersion: 'apiregistration.k8s.io/v1', source: 'apiService' },
    { kind: 'Service', name: 'services', groupVersion: 'v1', source: 'apiService' }
  ];
  const crdResources = [
    { kind: 'VirtualService', name: 'virtualservices', groupVersion: 'networking.istio.io/v1alpha3', source: 'crd' },
    { kind: 'Service', name: 'services', groupVersion: 'v1', source: 'crd' } // duplicate; should be deduped
  ];
  const discovered = [
    { kind: 'Service', name: 'services', groupVersion: 'v1', source: 'discovery' },
    { kind: 'Gateway', name: 'gateways', groupVersion: 'gateway.networking.k8s.io/v1beta1', source: 'discovery' }
  ];

  const results = unifiedLookup('service', { apiServices, crdResources, discovered });
  // deduped: services should appear only once
  const names = results.map(r => `${r.kind}:${r.groupVersion}:${r.name}`);
  assert.equal(names.filter(n => n.includes('Service:v1:services')).length, 1);
  // top result should be a Service (best match + core-service boost)
  assert.equal(results.length >= 1, true);
  assert.equal(results[0].kind, 'Service');
  // ensure APIService appears somewhere and VirtualService exists
  assert.ok(results.some(r => r.kind === 'APIService'));
  assert.ok(results.some(r => r.kind === 'VirtualService'));
});

test('unified lookup caps results to a maximum of 20 entries and is deterministic', () => {
  // create 30 synthetic candidates across sources; all look service-like by name
  const make = i => ({ kind: 'Thing' + (i % 3), name: `svc-${String(i).padStart(3,'0')}`, groupVersion: `example.com/v${i % 5}` });
  const all = Array.from({ length: 30 }, (_, i) => make(i + 1));
  // split across 3 sources
  const apiServices = all.slice(0, 10).map(r => ({ ...r, source: 'apiService' }));
  const crdResources = all.slice(10, 20).map(r => ({ ...r, source: 'crd' }));
  const discovered = all.slice(20).map(r => ({ ...r, source: 'discovery' }));

  const results = unifiedLookup('svc', { apiServices, crdResources, discovered });
  assert.equal(results.length, 20);
  // deterministic: repeated runs with same input should produce same ordered names
  const firstRun = results.map(r => r.name).join(',');
  const secondRun = unifiedLookup('svc', { apiServices, crdResources, discovered }).map(r => r.name).join(',');
  assert.equal(firstRun, secondRun);
});

// --- Detail mode: optional enriched details preserving identity ---

function detailedLookupFromRaw({ apiServices = [], crdResources = [], discovered = [] } = {}) {
  const out = [];
  // APIService-like
  for (const a of apiServices || []) {
    const candidate = {
      kind: a.kind || 'APIService',
      groupVersion: a.groupVersion || a.apiVersion || 'apiregistration.k8s.io/v1',
      name: a.name || a.metadata?.name || '',
      source: 'apiService'
    };
    const specService = a.spec?.service || a.service || (a?.spec) && a.spec.service;
    const statusConditions = a.status?.conditions || [];
    const availableCond = statusConditions.find(c => String(c.type).toLowerCase() === 'available');
    const available = availableCond ? (String(availableCond.status).toLowerCase() === 'true') : undefined;
    candidate.details = {
      backingService: specService ? {
        name: specService.name || specService.serviceName || '',
        namespace: specService.namespace || specService.serviceNamespace || undefined,
        port: specService.port || specService.servicePort || undefined
      } : undefined,
      availability: available === undefined ? undefined : { available, reason: availableCond?.reason || null }
    };
    out.push(candidate);
  }
  // CRD-backed entries
  for (const c of crdResources || []) {
    const candidate = {
      kind: c.kind || c.spec?.names?.kind || 'CustomResourceDefinition',
      groupVersion: c.groupVersion || (c.spec && `${c.spec.group}/${(c.spec.versions && c.spec.versions[0] && c.spec.versions[0].name) || ''}`) || '',
      name: c.name || c.metadata?.name || '',
      source: 'crd'
    };
    const spec = c.spec || c.crdSpec || {};
    candidate.details = {
      crd: {
        group: spec.group || null,
        versions: Array.isArray(spec.versions) ? spec.versions.map(v => v.name) : [],
        names: spec.names || null,
        scope: spec.scope || null
      }
    };
    out.push(candidate);
  }
  // discovered resources
  for (const d of discovered || []) {
    const candidate = {
      kind: d.kind,
      groupVersion: d.groupVersion || '',
      name: d.name,
      source: 'discovery'
    };
    candidate.details = {
      resource: {
        verbs: Array.isArray(d.verbs) ? d.verbs.slice() : undefined,
        namespaced: typeof d.namespaced === 'boolean' ? d.namespaced : undefined,
        categories: Array.isArray(d.categories) ? d.categories.slice() : undefined
      }
    };
    out.push(candidate);
  }
  // dedupe by identity (kind|groupVersion|name) preserve first occurrence
  const seen = new Set();
  return out.filter(c => {
    const key = `${c.kind}|${c.groupVersion}|${c.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

test('detail mode preserves identity and includes APIService-specific backing/availability details', () => {
  const apiRaw = [{
    kind: 'APIService',
    apiVersion: 'apiregistration.k8s.io/v1',
    name: 'v1.example.com',
    spec: { service: { name: 'my-api-backend', namespace: 'kube-system', port: 443 } },
    status: { conditions: [{ type: 'Available', status: 'True', reason: 'AllGood' }] }
  }];
  const details = detailedLookupFromRaw({ apiServices: apiRaw });
  assert.equal(details.length,1);
  const d = details[0];
  assert.equal(d.kind,'APIService');
  assert.equal(d.groupVersion,'apiregistration.k8s.io/v1');
  assert.equal(d.name,'v1.example.com');
  assert.equal(d.source,'apiService');
  assert.deepEqual(d.details.backingService, { name: 'my-api-backend', namespace: 'kube-system', port: 443 });
  assert.deepEqual(d.details.availability, { available: true, reason: 'AllGood' });
});

test('detail mode includes CRD group/versions/names/scope for CRD-backed resources', () => {
  const crdRaw = [{
    kind: 'CustomResourceDefinition',
    name: 'widgets.example.com',
    spec: {
      group: 'example.com',
      scope: 'Namespaced',
      names: { plural: 'widgets', singular: 'widget', kind: 'Widget' },
      versions: [{ name: 'v1', served: true }]
    }
  }];
  const details = detailedLookupFromRaw({ crdResources: crdRaw });
  assert.equal(details.length,1);
  const d = details[0];
  assert.equal(d.source,'crd');
  assert.equal(d.details.crd.group,'example.com');
  assert.deepEqual(d.details.crd.versions, ['v1']);
  assert.deepEqual(d.details.crd.names, { plural: 'widgets', singular: 'widget', kind: 'Widget' });
  assert.equal(d.details.crd.scope, 'Namespaced');
});

test('detail mode includes resource verbs/namespaced/categories for discovered service-like resources', () => {
  const discRaw = [{
    kind: 'Service',
    name: 'services',
    groupVersion: 'v1',
    verbs: ['get','list','watch'],
    namespaced: true,
    categories: ['core-service']
  }];
  const details = detailedLookupFromRaw({ discovered: discRaw });
  assert.equal(details.length,1);
  const d = details[0];
  assert.equal(d.kind,'Service');
  assert.equal(d.groupVersion,'v1');
  assert.equal(d.name,'services');
  assert.equal(d.source,'discovery');
  assert.deepEqual(d.details.resource.verbs, ['get','list','watch']);
  assert.equal(d.details.resource.namespaced, true);
  assert.deepEqual(d.details.resource.categories, ['core-service']);
});

// Minimal standalone helper that mirrors the planned config-selection behavior for tests:
import fs from 'node:fs';
import path from 'node:path';

function selectKubeConfigFromEnv() {
  // Prefer a non-empty KUBECONFIG env var; otherwise allow a local default at ./.kube/config.
  const v = process.env.KUBECONFIG;
  if (typeof v === 'string' && v.trim() !== '') {
    return v;
  }
  const localDefault = path.resolve(process.cwd(), '.kube', 'config');
  try {
    const st = fs.statSync(localDefault);
    if (st.isFile()) return localDefault;
  } catch (e) {
    // ignore: no local default available
  }
  throw new Error('KUBECONFIG must be set and non-empty, or a local kubeconfig at ./.kube/config must exist');
}

// Unit tests for Option B behavior: prefer non-empty KUBECONFIG; else accept local default; else throw.
test('non-empty KUBECONFIG is accepted and returned as-is', () => {
  const prev = process.env.KUBECONFIG;
  try {
    process.env.KUBECONFIG = '/path/to/kubeconfig';
    const got = selectKubeConfigFromEnv();
    assert.equal(got, '/path/to/kubeconfig');
  } finally {
    if (prev === undefined) delete process.env.KUBECONFIG; else process.env.KUBECONFIG = prev;
  }
});

test('missing/blank KUBECONFIG with local default available is accepted and returns local path', () => {
  const prevEnv = process.env.KUBECONFIG;
  const localDefault = path.resolve(process.cwd(), '.kube', 'config');
  // backup existing local default if present
  const backup = localDefault + '.bak';
  let hadBackup = false;
  try {
    if (fs.existsSync(localDefault)) {
      fs.renameSync(localDefault, backup);
      hadBackup = true;
    } else {
      // ensure directory exists
      fs.mkdirSync(path.dirname(localDefault), { recursive: true });
    }
    // create a minimal kubeconfig file
    fs.writeFileSync(localDefault, 'apiVersion: v1\nclusters: []\n');
    delete process.env.KUBECONFIG;
    const got = selectKubeConfigFromEnv();
    assert.equal(got, localDefault);
  } finally {
    // cleanup created file
    try { fs.unlinkSync(localDefault); } catch(e) {}
    if (hadBackup) {
      try { fs.renameSync(backup, localDefault); } catch(e) {}
    } else {
      // try remove directory if empty
      try { fs.rmdirSync(path.dirname(localDefault)); } catch(e) {}
    }
    if (prevEnv === undefined) delete process.env.KUBECONFIG; else process.env.KUBECONFIG = prevEnv;
  }
});

test('missing/blank KUBECONFIG with no local default throws', () => {
  const prevEnv = process.env.KUBECONFIG;
  const localDefault = path.resolve(process.cwd(), '.kube', 'config');
  // backup existing local default if present
  const backup = localDefault + '.bak';
  let hadBackup = false;
  try {
    if (fs.existsSync(localDefault)) {
      fs.renameSync(localDefault, backup);
      hadBackup = true;
    }
    delete process.env.KUBECONFIG;
    assert.throws(() => selectKubeConfigFromEnv(), /KUBECONFIG/);
  } finally {
    if (hadBackup) {
      try { fs.renameSync(backup, localDefault); } catch(e) {}
    }
    if (prevEnv === undefined) delete process.env.KUBECONFIG; else process.env.KUBECONFIG = prevEnv;
  }
});

