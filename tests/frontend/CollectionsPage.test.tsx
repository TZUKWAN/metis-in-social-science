/**
 * CollectionsPage tests.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CollectionsPage from '../../src/pages/CollectionsPage';
import { useMetisStore } from '../../src/store';

function resetStore() {
  useMetisStore.setState({
    papers: [],
    collections: [],
    selectedCollection: null,
    paperFilter: { query: '' },
    locale: 'en',
  });
}

function makeCollection(overrides?: Partial<ReturnType<typeof useMetisStore.getState>['collections'][number]>) {
  return {
    id: `collection_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: 'Test Collection',
    description: '',
    paperIds: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

function makePaper(overrides?: Partial<ReturnType<typeof useMetisStore.getState>['papers'][number]>) {
  return {
    id: `paper_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: 'Test Paper',
    authors: ['A. Author'],
    year: 2024,
    venue: 'Conf',
    abstract: 'Abstract',
    doi: '',
    tags: [],
    notes: '',
    readStatus: 'unread' as const,
    rating: 0,
    referenceIds: [],
    addedAt: Date.now(),
    ...overrides,
  };
}

describe('CollectionsPage', () => {
  beforeEach(() => {
    resetStore();
  });

  it('renders empty state when there are no collections', () => {
    render(<CollectionsPage onNavigate={vi.fn()} />);
    expect(screen.getByText(/No collections yet/i)).toBeTruthy();
  });

  it('creates a new collection', async () => {
    render(<CollectionsPage onNavigate={vi.fn()} />);

    const nameInput = screen.getByPlaceholderText(/Collection name/i);
    fireEvent.change(nameInput, { target: { value: 'Neural Networks' } });

    const descInput = screen.getByPlaceholderText(/Description/i);
    fireEvent.change(descInput, { target: { value: 'Papers about NNs' } });

    fireEvent.click(screen.getByRole('button', { name: /Create/i }));

    await waitFor(() => {
      expect(useMetisStore.getState().collections.length).toBe(1);
    });

    const collection = useMetisStore.getState().collections[0]!;
    expect(collection.name).toBe('Neural Networks');
    expect(collection.description).toBe('Papers about NNs');
    expect(screen.getByText('Neural Networks')).toBeTruthy();
    expect(screen.getByText('Papers about NNs')).toBeTruthy();
  });

  it('shows validation error when creating without a name', () => {
    render(<CollectionsPage onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Create/i }));
    expect(screen.getByText(/Collection name is required/i)).toBeTruthy();
  });

  it('opens a collection in the papers page', async () => {
    const onNavigate = vi.fn();
    const collection = makeCollection({ name: 'Read List', paperIds: ['paper-1'] });

    useMetisStore.setState({
      papers: [makePaper({ id: 'paper-1', title: 'Paper One' })],
      collections: [collection],
    });

    render(<CollectionsPage onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('button', { name: /Open Papers/i }));

    await waitFor(() => {
      expect(useMetisStore.getState().selectedCollection).toBe(collection.id);
      expect(useMetisStore.getState().paperFilter.collectionId).toBe(collection.id);
    });

    expect(onNavigate).toHaveBeenCalledWith('papers');
  });

  it('edits a collection', async () => {
    const collection = makeCollection({ name: 'Old Name' });
    useMetisStore.setState({ collections: [collection] });

    render(<CollectionsPage onNavigate={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Edit/i }));

    const nameInput = screen.getByDisplayValue('Old Name');
    fireEvent.change(nameInput, { target: { value: 'New Name' } });

    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => {
      expect(useMetisStore.getState().collections[0]!.name).toBe('New Name');
    });

    expect(screen.getByText('New Name')).toBeTruthy();
  });

  it('deletes a collection after confirmation', async () => {
    const collection = makeCollection({ name: 'To Delete' });
    useMetisStore.setState({ collections: [collection] });

    render(<CollectionsPage onNavigate={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Delete/i }));

    expect(screen.getByText(/Are you sure/i)).toBeTruthy();

    fireEvent.click(screen.getByTestId('confirm-delete'));

    await waitFor(() => {
      expect(useMetisStore.getState().collections.length).toBe(0);
    });

    expect(screen.queryByText('To Delete')).toBeNull();
  });

  it('displays the correct paper count for a collection', () => {
    const collection = makeCollection({ paperIds: ['paper-1', 'paper-2'] });

    useMetisStore.setState({
      papers: [
        makePaper({ id: 'paper-1' }),
        makePaper({ id: 'paper-2' }),
        makePaper({ id: 'paper-3' }),
      ],
      collections: [collection],
    });

    render(<CollectionsPage onNavigate={vi.fn()} />);
    expect(screen.getByText('2 papers')).toBeTruthy();
  });
});
