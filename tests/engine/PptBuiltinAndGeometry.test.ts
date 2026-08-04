/**
 * PptBuiltinDefinitions + findNonOverlappingPosition.
 */

import { describe, expect, it } from 'vitest';
import { buildPptAgent, buildPptScenario, PPT_AGENT_SYSTEM_PROMPT_PLACEHOLDER } from '../../engine/personalization/PptBuiltinDefinitions.js';
import { findNonOverlappingPosition } from '../../electron/OfficeCliService.js';

describe('PptBuiltinDefinitions', () => {
  it('builds a valid PPT agent with a placeholder system prompt', () => {
    const agent = buildPptAgent();
    expect(agent.kind).toBe('agent');
    expect(agent.id).toBe('builtin:agents/officecli-ppt');
    expect(agent.role).toBe('presentation');
    expect(agent.systemPrompt).toContain('占位');
  });

  it('builds a PPT scenario with trigger phrases and a workflow', () => {
    const scenario = buildPptScenario();
    expect(scenario.kind).toBe('scenario');
    expect(scenario.id).toBe('builtin:scenarios/officecli-ppt');
    expect(scenario.triggerPhrases).toContain('做个PPT');
    expect(scenario.triggerPhrases).toContain('create presentation');
    expect(scenario.workflow).toHaveLength(1);
    expect(scenario.workflow[0]?.agentId).toBe('builtin:agents/officecli-ppt');
  });

  it('exposes the placeholder prompt for the user to replace', () => {
    expect(PPT_AGENT_SYSTEM_PROMPT_PLACEHOLDER).toContain('请替换');
    expect(PPT_AGENT_SYSTEM_PROMPT_PLACEHOLDER).toContain('提示词');
  });
});

describe('findNonOverlappingPosition', () => {
  it('returns the proposed position when no shapes exist', () => {
    const result = findNonOverlappingPosition([], { x: 72, y: 72, w: 200, h: 100 });
    expect(result).toEqual({ x: 72, y: 72 });
  });

  it('nudges down when the proposed position overlaps an existing shape', () => {
    const existing = [{ x: '2.5cm', y: '2cm', width: '8cm', height: '3cm' }];
    const result = findNonOverlappingPosition(existing, { x: 70, y: 56, w: 227, h: 85 });
    // Should have moved down to avoid the shape.
    expect(result.y).toBeGreaterThan(56);
  });

  it('returns the same position when shapes do not overlap', () => {
    const existing = [{ x: '15cm', y: '15cm', width: '3cm', height: '3cm' }];
    const result = findNonOverlappingPosition(existing, { x: 28, y: 28, w: 85, h: 56 });
    expect(result).toEqual({ x: 28, y: 28 });
  });
});
