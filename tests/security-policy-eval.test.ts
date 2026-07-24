import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Tool } from '@openai/agents';
import { SECURITY_PROFILES } from '../src/config.js';
import { decideEvent, SOURCE_POLICY_ACCESS_LEVELS } from '../src/daemon/policy.js';
import type { EventEnvelope } from '../src/daemon/types.js';
import {
  TOOL_DESCRIPTORS,
  toolsForPermission,
  toolsForRunPolicy,
} from '../src/runtime/tool-policy.js';

const fixtureSchema = z.object({
  schemaVersion: z.literal(1),
  cases: z.array(z.object({
    id: z.string().min(1),
    trust: z.enum(['owner', 'trusted', 'external', 'public', 'system']),
    securityProfile: z.enum(['safe', 'workstation', 'full-owner']),
    sourcePolicyAccess: z.enum(SOURCE_POLICY_ACCESS_LEVELS).optional(),
    prompt: z.string().min(1),
    expectedAllowedTools: z.array(z.string()).optional(),
    forbiddenTools: z.array(z.string()).min(1),
    allowMcp: z.boolean(),
    allowSessionContext: z.boolean(),
  }).strict()).min(1),
}).strict();

test('checked-in prompt injection cases cannot expand provenance or deployment authority', async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const fixture = fixtureSchema.parse(JSON.parse(await readFile(
    path.join(directory, '../evals/security-policy-cases.json'),
    'utf8',
  )) as unknown);
  const allTools = [
    ...TOOL_DESCRIPTORS.map((descriptor) => ({ name: descriptor.name }) as Tool),
    { name: 'unknown_extension' } as Tool,
  ];
  for (const securityCase of fixture.cases) {
    const at = '2026-07-24T00:00:00.000Z';
    const event: EventEnvelope = {
      id: `event-${securityCase.id}`,
      externalId: securityCase.id,
      source: 'security-eval',
      kind: 'command',
      trust: securityCase.trust,
      payload: { text: securityCase.prompt },
      occurredAt: at,
      receivedAt: at,
      priority: 80,
      profileId: 'owner',
    };
    const decision = decideEvent(
      event,
      [],
      undefined,
      securityCase.sourcePolicyAccess,
    );
    assert.equal(decision.action, 'run', securityCase.id);
    const policy = decision.options?.policy;
    assert.ok(policy, `${securityCase.id} unexpectedly received unrestricted owner policy`);
    assert.equal(policy.allowMcp, securityCase.allowMcp, securityCase.id);
    assert.equal(policy.allowSessionContext, securityCase.allowSessionContext, securityCase.id);
    const profile = SECURITY_PROFILES[securityCase.securityProfile];
    const deploymentTools = toolsForPermission(
      profile.permissionMode,
      allTools,
      {},
      profile.id,
    );
    const allowed = toolsForRunPolicy(deploymentTools, policy).map((tool) => tool.name).sort();
    if (securityCase.expectedAllowedTools) {
      assert.deepEqual(allowed, [...securityCase.expectedAllowedTools].sort(), securityCase.id);
    }
    for (const forbidden of securityCase.forbiddenTools) {
      assert.equal(allowed.includes(forbidden), false, `${securityCase.id} exposed ${forbidden}`);
    }
  }
});
