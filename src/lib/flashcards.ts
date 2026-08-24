/**
 * Flashcard storage — SQLite-backed via IPC (production), localStorage fallback
 * (test/non-Electron environments). Kept outside the component file so the
 * panel file only exports components (react-refresh).
 */

export interface Flashcard {
  id: string;
  front: string;
  back: string;
  /** Next due timestamp (ms). */
  dueAt: number;
  /** Current interval in days. */
  intervalDays: number;
  createdAt: number;
}

const STORAGE_KEY = 'metis-flashcards';

/** Load all flashcards (IPC if available, else localStorage). */
export async function loadFlashcards(): Promise<Flashcard[]> {
  const metis = (typeof window !== 'undefined' ? (window as { metis?: { flashcardList?: () => Promise<{ cards: Array<Record<string, unknown>> }> } }).metis : undefined);
  if (metis?.flashcardList) {
    try {
      const result = await metis.flashcardList();
      return (result.cards ?? []) as unknown as Flashcard[];
    } catch { /* fall through */ }
  }
  // localStorage fallback (test/browser-only environments).
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is Flashcard =>
      typeof c === 'object' && c !== null
      && typeof (c as Flashcard).id === 'string'
      && typeof (c as Flashcard).front === 'string'
      && typeof (c as Flashcard).back === 'string');
  } catch {
    return [];
  }
}

/** Save all flashcards to the backing store. */
export async function saveFlashcards(cards: Flashcard[]): Promise<void> {
  const metis = (typeof window !== 'undefined' ? (window as { metis?: { flashcardSave?: (c: Record<string, unknown>) => Promise<{ ok: boolean }> } }).metis : undefined);
  if (metis?.flashcardSave) {
    for (const card of cards) {
      try { await metis.flashcardSave(card as unknown as Record<string, unknown>); } catch { /* best-effort */ }
    }
    return;
  }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cards)); } catch { /* best-effort */ }
}

/** Save a single card. */
export async function addFlashcard(front: string, back: string): Promise<void> {
  const card: Flashcard = {
    id: `fc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    front,
    back,
    dueAt: Date.now(),
    intervalDays: 1,
    createdAt: Date.now(),
  };
  await saveFlashcards([card]);
}

/** Delete a card by id. */
export async function deleteFlashcard(id: string): Promise<void> {
  const metis = (typeof window !== 'undefined' ? (window as { metis?: { flashcardDelete?: (id: string) => Promise<{ ok: boolean }> } }).metis : undefined);
  if (metis?.flashcardDelete) {
    try { await metis.flashcardDelete(id); } catch { /* best-effort */ }
    return;
  }
  const cards = await loadFlashcards();
  await saveFlashcards(cards.filter((c) => c.id !== id));
}

/** Update a card (e.g. after grading — new dueAt/intervalDays). */
export async function updateFlashcard(card: Flashcard): Promise<void> {
  await saveFlashcards([card]);
}

export function flashcardCount(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as unknown[]).length : 0;
  } catch { return 0; }
}

/** Module-level impure timestamp (kept out of component bodies). */
export function flashcardNow(): number {
  return Date.now();
}
