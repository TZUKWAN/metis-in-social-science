/**
 * Tests for PersistenceStore — SQLite-backed session/message storage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

let store: PersistenceStore;
let dbPath: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-test-'));
  dbPath = path.join(tmpDir, 'test.db');
  store = new PersistenceStore(dbPath);
});

afterEach(() => {
  store?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('PersistenceStore', () => {
  it('creates and retrieves a session', () => {
    store.createSession('sess-1', { profile: 'small' });
    const session = store.getSession('sess-1');

    expect(session).toBeDefined();
    expect(session!.id).toBe('sess-1');
    expect(session!.metadata.profile).toBe('small');
    expect(session!.messageCount).toBe(0);
  });

  it('lists sessions ordered by last activity', () => {
    store.createSession('a');
    store.createSession('b');
    store.createSession('c');

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(3);
  });

  it('appends and retrieves messages', () => {
    store.createSession('s1');
    store.appendMessage('s1', 'system', 'You are helpful.');
    store.appendMessage('s1', 'user', 'Hello');
    store.appendMessage('s1', 'assistant', 'Hi there!');

    const messages = store.getMessages('s1');
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('system');
    expect(messages[1].content).toBe('Hello');
    expect(messages[2].role).toBe('assistant');
  });

  it('updates message count on append', () => {
    store.createSession('s2');
    store.appendMessage('s2', 'user', 'msg1');
    store.appendMessage('s2', 'user', 'msg2');

    const session = store.getSession('s2');
    expect(session!.messageCount).toBe(2);
    expect(store.getMessageCount('s2')).toBe(2);
  });

  it('truncates messages after the last user and repairs the session count', () => {
    store.createSession('s2-truncate');
    store.appendMessage('s2-truncate', 'user', 'question');
    store.appendMessage('s2-truncate', 'assistant', 'old answer');
    store.appendMessage('s2-truncate', 'tool', 'stale tool output');

    expect(store.truncateMessagesAfterLastUser('s2-truncate')).toBe(2);
    expect(store.getMessages('s2-truncate')).toEqual([
      { role: 'user', content: 'question' },
    ]);
    expect(store.getSession('s2-truncate')?.messageCount).toBe(1);
  });

  it('records and retrieves tool results', () => {
    store.createSession('s3');
    store.recordToolResult('s3', {
      toolName: 'echo',
      content: 'Echo: hello',
      status: 'ok',
      toolCallId: 'tc_1',
      metadata: {},
    });
    store.recordToolResult('s3', {
      toolName: 'fail_tool',
      content: '',
      status: 'error',
      toolCallId: 'tc_2',
      error: 'Something went wrong',
      metadata: {},
    });

    const results = store.getToolResults('s3');
    expect(results).toHaveLength(2);
    expect(results[0].toolName).toBe('echo');
    expect(results[0].status).toBe('ok');
    expect(results[1].toolName).toBe('fail_tool');
    expect(results[1].error).toBe('Something went wrong');
  });

  it('records and retrieves checkpoints', () => {
    store.createSession('s4');
    store.recordCheckpoint('s4', 'agent.start', 'started', 0);
    store.recordCheckpoint('s4', 'agent.complete', 'done', 5, { turns: 5 });

    const checkpoints = store.getCheckpoints('s4');
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0].phase).toBe('agent.start');
    expect(checkpoints[1].metadata).toEqual({ turns: 5 });
  });

  it('deletes a session and its data', () => {
    store.createSession('s5');
    store.appendMessage('s5', 'user', 'test');
    store.recordToolResult('s5', {
      toolName: 'echo', content: 'hi', status: 'ok', toolCallId: 'tc', metadata: {},
    });

    store.deleteSession('s5');

    expect(store.getSession('s5')).toBeUndefined();
    expect(store.getMessages('s5')).toHaveLength(0);
    expect(store.getToolResults('s5')).toHaveLength(0);
  });

  it('saves and retrieves workflow runs', () => {
    store.saveWorkflowRun({
      id: 'wf-1',
      workflowId: 'literature-review',
      status: 'completed',
      currentStepId: null,
      stepResults: { search: { status: 'completed' } },
      input: { topic: 'AI' },
      errors: [],
      startedAt: Date.now() - 1000,
      completedAt: Date.now(),
    });

    const run = store.getWorkflowRun('wf-1');
    expect(run).toBeDefined();
    expect(run!.status).toBe('completed');
  });

  it('saves eval runs', () => {
    store.saveEvalRun({
      id: 'eval-1',
      suiteName: 'test-suite',
      status: 'completed',
      successRate: 0.95,
      taskCount: 20,
      passedCount: 19,
      resultsJson: '[]',
      createdAt: Date.now(),
    });

    // Verify no errors
    const session = store.listSessions(1);
    // eval_runs is separate from sessions
    expect(session).toHaveLength(0);
  });

  it('handles limit parameter in getMessages', () => {
    store.createSession('s6');
    for (let i = 0; i < 10; i++) {
      store.appendMessage('s6', 'user', `msg ${i}`);
    }

    const limited = store.getMessages('s6', 5);
    expect(limited).toHaveLength(5);
    expect(limited[0].content).toBe('msg 0');
  });

  it('updates session metadata', () => {
    store.createSession('s7', { title: 'Old' });
    store.updateSession('s7', { metadata: { title: 'New', archived: true } });
    const session = store.getSession('s7');
    expect(session).toBeDefined();
    expect(session!.metadata.title).toBe('New');
    expect(session!.metadata.archived).toBe(true);
  });

  it('creates, lists and deletes artifacts', () => {
    store.createSession('s8');
    store.createArtifact({
      id: 'art-1',
      sessionId: 's8',
      name: 'paper.pdf',
      type: 'pdf',
      path: '/workspace/paper.pdf',
      size: '1.2MB',
    });
    store.createArtifact({
      id: 'art-2',
      sessionId: 's8',
      name: 'data.xlsx',
      type: 'xlsx',
      path: '/workspace/data.xlsx',
      size: '45KB',
    });

    const artifacts = store.listArtifacts('s8');
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].name).toBe('data.xlsx');

    store.deleteArtifact('art-1');
    expect(store.listArtifacts('s8')).toHaveLength(1);
  });

  it('saves and retrieves paper pdfText', () => {
    store.savePaper({
      id: 'paper-1',
      title: 'Attention Is All You Need',
      authors: ['A Vaswani'],
      year: 2017,
      venue: 'NeurIPS',
      abstract: 'We propose the Transformer.',
      doi: '10.1234/test',
      pdfPath: '/data/papers/attention.pdf',
      pdfText: 'The transformer relies entirely on attention mechanisms.',
      citationCount: 12000,
      tags: ['transformer'],
      notes: '',
      readStatus: 'read',
      rating: 5,
      addedAt: Date.now(),
    });

    const papers = store.getPapers();
    expect(papers).toHaveLength(1);
    expect(papers[0]!.pdfText).toBe('The transformer relies entirely on attention mechanisms.');
    expect(papers[0]!.citationCount).toBe(12000);
  });

  it('saves and retrieves collections', () => {
    store.saveCollection({
      id: 'col-1',
      name: 'Transformers',
      description: 'Transformer papers',
      paperIds: ['paper-1', 'paper-2'],
      createdAt: Date.now(),
    });

    const collections = store.getCollections();
    expect(collections).toHaveLength(1);
    expect(collections[0]!.name).toBe('Transformers');
    expect(collections[0]!.paperIds).toEqual(['paper-1', 'paper-2']);

    store.deleteCollection('col-1');
    expect(store.getCollections()).toHaveLength(0);
  });

  it('searches local library across papers and notes', () => {
    store.savePaper({
      id: 'paper-1',
      title: 'Attention Is All You Need',
      authors: ['Vaswani et al.'],
      year: 2017,
      venue: 'NeurIPS',
      abstract: 'We propose the transformer architecture for sequence modeling.',
      doi: '10.1234/attention',
      pdfText: 'The transformer relies entirely on self-attention.',
      tags: ['transformers'],
      notes: '',
      readStatus: 'unread',
      rating: 0,
      addedAt: Date.now(),
    });
    store.saveNote({
      id: 'note-1',
      title: 'Transformer Notes',
      content: 'Self-attention computes pairwise interactions between tokens.',
      tags: ['attention'],
      linkedPaperIds: ['paper-1'],
      linkedNoteIds: [],
      updatedAt: Date.now(),
    });

    const results = store.searchLibrary('attention transformer', 5);

    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]!.score).toBeGreaterThan(0);
    expect(results.some((r) => r.type === 'paper')).toBe(true);
    expect(results.some((r) => r.type === 'note')).toBe(true);
  });
});
