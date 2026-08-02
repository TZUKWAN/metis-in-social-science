/**
 * Tests for RagEngine document persistence — index survives serialization.
 */

import { describe, it, expect } from 'vitest';
import { RagEngine, type RagDocument } from './RagEngine.js';

function doc(id: string, content: string): RagDocument {
  return { id, title: `Title ${id}`, content, metadata: { year: 2024 } };
}

describe('RagEngine persistence', () => {
  it('round-trips documents through serialize/load and keeps search working', () => {
    const engine = new RagEngine();
    engine.indexDocuments([
      doc('a', 'deep learning transformer attention'),
      doc('b', 'reinforcement learning policy gradient'),
    ]);
    const payload = engine.serializeDocuments();

    // A fresh engine (simulating a restart) loads the persisted payload.
    const restarted = new RagEngine();
    const loaded = restarted.loadSerializedDocuments(payload);
    expect(loaded).toBe(2);
    expect(restarted.stats().documentCount).toBe(2);

    // Search works on the restored index.
    const results = restarted.search('transformer attention', 2);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.document.id).toBe('a');
  });

  it('rejects malformed payloads without crashing', () => {
    const engine = new RagEngine();
    expect(engine.loadSerializedDocuments('not-json')).toBe(0);
    expect(engine.loadSerializedDocuments('{"no":"docs"}')).toBe(0);
    expect(engine.stats().documentCount).toBe(0);
  });

  it('filters invalid entries when loading', () => {
    const engine = new RagEngine();
    const mixed = JSON.stringify([
      { id: 'ok', title: 'T', content: 'real content', metadata: {} },
      { id: 42, content: 'no string id' },
      { id: 'missing-content' },
    ]);
    expect(engine.loadSerializedDocuments(mixed)).toBe(1);
  });

  it('indexPapers content includes title, abstract, and notes', () => {
    const engine = new RagEngine();
    engine.indexPapers([{
      id: 'p1', title: 'Neural Methods', authors: [], year: 2023, venue: 'V',
      abstract: 'graph neural networks', notes: 'important for graph tasks',
      tags: [], readStatus: 'unread', rating: 0, referenceIds: [], addedAt: 1,
    } as never]);
    const results = engine.search('graph', 1);
    expect(results[0]!.document.id).toBe('p1');
  });
});
