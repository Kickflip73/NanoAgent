import assert from 'node:assert/strict';
import test from 'node:test';
import type { Tool } from '@openai/agents';
import {
  isSideEffectTool,
  subAgentToolNames,
  teamRoleToolNames,
  toolNamesForMode,
  toolsForMode,
  toolsForPermission,
  toolsForRunPolicy,
} from '../src/runtime/tool-policy.js';

const fakeTool = (name: string) => ({ name }) as Tool;

test('preserves mode and permission tool policy semantics', () => {
  const tools = [
    'read_file', 'write_file', 'edit_file', 'move_file', 'run_shell',
    'http_get', 'http_request', 'update_plan', 'unknown_extension',
  ].map(fakeTool);

  assert.deepEqual(
    toolsForMode('plan', tools).map((tool) => tool.name),
    ['read_file', 'http_get', 'update_plan'],
  );
  assert.deepEqual(
    toolsForMode('general', tools).map((tool) => tool.name),
    tools.map((tool) => tool.name),
  );
  assert.deepEqual(
    toolsForMode('ultra', tools, [fakeTool('run_team')]).map((tool) => tool.name),
    [...tools.map((tool) => tool.name), 'run_team'],
  );
  assert.deepEqual(
    toolsForPermission('workspace', tools).map((tool) => tool.name),
    ['read_file', 'write_file', 'edit_file', 'move_file', 'http_get', 'update_plan'],
  );
  assert.deepEqual(
    toolsForPermission('read-only', tools).map((tool) => tool.name),
    ['read_file', 'http_get'],
  );
  assert.deepEqual(
    toolsForPermission('read-only', tools, { unknown_extension: ['read'] }).map((tool) => tool.name),
    ['read_file', 'http_get', 'unknown_extension'],
  );
  assert.deepEqual(
    toolsForPermission('trusted', tools).map((tool) => tool.name),
    tools.map((tool) => tool.name),
  );
});

test('read-only local deployment still exposes configured connector transactions', () => {
  const tools = [
    'read_file', 'write_file', 'remember', 'update_plan', 'connector_action',
  ].map(fakeTool);

  assert.deepEqual(
    toolsForPermission('read-only', tools).map((tool) => tool.name),
    ['read_file', 'connector_action'],
  );
});

test('event run policy fails closed for unknown tools and state mutations', () => {
  const tools = ['read_file', 'write_file', 'http_get', 'update_plan', 'runtime_status', 'unknown_extension'].map(fakeTool);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['read', 'network-read'],
    allowSideEffects: false,
    allowUnknownTools: false,
  }).map((tool) => tool.name), ['read_file', 'http_get']);
});

test('external event policy keeps only the explicit low-risk delivery control', () => {
  const tools = ['finish_mimi_silently', 'runtime_status', 'request_mimi_briefing'].map(fakeTool);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['delivery-control'],
    allowSideEffects: false,
    allowUnknownTools: false,
  }).map((tool) => tool.name), ['finish_mimi_silently']);
});

test('explicit run policies can expose only selected side-effect tool names', () => {
  const write = fakeTool('write_file');
  const edit = fakeTool('edit_file');
  const shell = fakeTool('run_shell');
  assert.deepEqual(toolsForRunPolicy([write, edit, shell], {
    allowedCapabilities: ['write', 'execute'],
    allowSideEffects: true,
    allowedSideEffectTools: ['write_file'],
  }).map((tool) => tool.name), ['write_file']);
});

test('explicit run policies can bound both read-only and side-effect tools by name', () => {
  const tools = ['read_file', 'list_memories', 'run_shell', 'upsert_mimi_source_policy'].map(fakeTool);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['read', 'memory-read', 'execute', 'state-write'],
    allowedTools: ['read_file', 'run_shell'],
    allowSideEffects: true,
    allowedSideEffectTools: ['run_shell'],
  }).map((tool) => tool.name), ['read_file', 'run_shell']);
});

test('preserves SubAgent and Team role tool order', () => {
  assert.deepEqual(subAgentToolNames('researcher'), [
    'current_time', 'read_file', 'list_directory', 'search_files', 'http_get', 'web_search', 'search_knowledge',
  ]);
  assert.deepEqual(subAgentToolNames('architect'), [
    'read_file', 'list_directory', 'search_files', 'web_search', 'search_knowledge',
  ]);
  assert.deepEqual(subAgentToolNames('reviewer'), [
    'read_file', 'list_directory', 'search_files', 'search_knowledge',
  ]);

  assert.deepEqual(teamRoleToolNames('explorer'), [
    'current_time', 'read_file', 'list_directory', 'search_files', 'http_get', 'web_search', 'search_knowledge',
  ]);
  assert.deepEqual(teamRoleToolNames('architect'), [
    'read_file', 'list_directory', 'search_files', 'web_search', 'search_knowledge',
  ]);
  assert.deepEqual(teamRoleToolNames('builder'), [
    'current_time', 'calculate', 'read_file', 'write_file', 'edit_file', 'move_file',
    'list_directory', 'search_files', 'search_knowledge',
  ]);
  assert.deepEqual(teamRoleToolNames('tester'), [
    'current_time', 'calculate', 'read_file', 'list_directory', 'search_files', 'search_knowledge',
  ]);
  assert.deepEqual(teamRoleToolNames('reviewer'), [
    'read_file', 'list_directory', 'search_files', 'search_knowledge',
  ]);
  assert.deepEqual(teamRoleToolNames('builder', true), [
    'current_time', 'calculate', 'read_file', 'write_file', 'edit_file', 'move_file',
    'list_directory', 'search_files', 'search_knowledge', 'run_shell',
  ]);
});

test('classifies the existing durable side-effect tools from one policy source', () => {
  const sideEffects = [
    'write_file', 'edit_file', 'move_file', 'run_shell', 'http_request', 'connector_action',
    'set_mimi_connector_enabled', 'reload_mimi_connectors', 'index_knowledge',
    'remember', 'forget', 'update_plan', 'set_goal', 'update_goal',
    'snooze_mimi', 'clear_mimi_snooze',
    'cancel_interrupted_mimi_task',
    'set_team_tasks', 'claim_team_task', 'update_team_task', 'retry_team_task', 'run_team',
    'switch_model', 'switch_mode', 'set_output_level', 'switch_session', 'new_session',
    'clear_session', 'reload_mcp', 'request_exit',
  ];
  for (const name of sideEffects) assert.equal(isSideEffectTool(name), true, name);
  for (const name of [
    'read_file', 'http_get', 'recall', 'show_plan', 'delegate_review',
    'prepare_task', 'finish_task', 'finish_mimi_silently', 'get_mimi_snooze', 'unknown_extension',
  ]) {
    assert.equal(isSideEffectTool(name), false, name);
  }
});

test('derives displayed orchestration tools from mode policy', () => {
  const base = [fakeTool('read_file'), fakeTool('write_file')];
  assert.deepEqual(toolNamesForMode('general', base), [
    'delegate_background_task', 'delegate_research', 'delegate_review', 'read_file', 'write_file',
  ]);
  assert.deepEqual(toolNamesForMode('plan', base), [
    'delegate_architecture', 'delegate_research', 'delegate_review', 'read_file',
  ]);
  assert.deepEqual(toolNamesForMode('ultra', base), [
    'claim_team_task', 'delegate_architecture', 'delegate_background_task', 'delegate_research', 'delegate_review',
    'read_file', 'retry_team_task', 'run_team', 'set_team_tasks', 'show_team_tasks',
    'update_team_task', 'write_file',
  ]);
  assert.deepEqual(toolNamesForMode('ultra', base, 'workspace'), [
    'claim_team_task', 'delegate_architecture', 'delegate_background_task', 'delegate_research', 'delegate_review',
    'read_file', 'retry_team_task', 'set_team_tasks', 'show_team_tasks',
    'update_team_task', 'write_file',
  ]);
  assert.deepEqual(toolNamesForMode('ultra', base, 'read-only'), [
    'delegate_architecture', 'delegate_research', 'delegate_review', 'read_file',
    'show_team_tasks',
  ]);
});

test('read-only deployment hides local durable writes but keeps connector transactions', () => {
  const tools = [
    'read_file', 'write_file', 'remember', 'update_plan', 'connector_action',
    'show_plan', 'inspect_mimi_capabilities',
  ].map(fakeTool);
  assert.deepEqual(toolsForPermission('read-only', tools).map((tool) => tool.name), [
    'read_file', 'connector_action', 'show_plan', 'inspect_mimi_capabilities',
  ]);
});
