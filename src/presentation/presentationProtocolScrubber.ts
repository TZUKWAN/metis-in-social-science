import { sanitizeUnifiedProtocolText } from '../../engine/runtime/UnifiedStreamProtocolGate.js';

const PROTECTED_INTERACTIVE_FENCE = /```[ \t]*(?:metis-choice-group|metis-journal-card|metis-submission-card)[^\n`]*\n[\s\S]*?```/giu;
const PLACEHOLDER_PREFIX = '\uE000METIS_INTERACTIVE_FENCE_';
const PLACEHOLDER_SUFFIX = '\uE001';

/**
 * Sanitize text for presentation without changing persisted source content.
 * Interactive METIS fences are restored byte-for-byte after protocol cleanup.
 */
export function scrubPresentationProtocol(text: string): string {
  if (!text) return text;
  const protectedFences: string[] = [];
  const protectedText = text.replace(PROTECTED_INTERACTIVE_FENCE, (fence) => {
    const index = protectedFences.push(fence) - 1;
    return `${PLACEHOLDER_PREFIX}${index}${PLACEHOLDER_SUFFIX}`;
  });
  const cleaned = sanitizeUnifiedProtocolText(protectedText);
  return cleaned.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'gu'),
    (_match, index: string) => protectedFences[Number(index)] ?? '',
  );
}

const JSON_ENVELOPE_RE = /^\s*\{[\s\S]*\}\s*$/u;
/** Truncated envelopes end mid-answer (clipped at 600 chars by the main process). */
const ANSWER_ENVELOPE_START_RE = /^\s*\{\s*"answer"\s*:/u;
/** Truncation marker the main process appends to oversized persisted answers. */
const TRUNCATION_MARKER_RE = /…（回答过长已截断；本次没有产生可应用的修改）\s*$/u;

/**
 * Extract the `answer` field from a persisted assistant envelope. Legacy rows
 * are not always valid JSON: models sometimes emit unescaped quotes inside the
 * answer, and the main process clips oversized rows at 600 chars. Strict parse
 * first, then tolerant field extraction, then a truncated-envelope fallback.
 */
function extractOutcomeAnswerField(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { answer?: unknown };
    // Valid JSON is authoritative: an empty/absent answer means there is
    // nothing to project, and the tolerant paths below must not run.
    return typeof parsed.answer === 'string' && parsed.answer.trim() ? parsed.answer : null;
  } catch {
    // Malformed JSON — fall through to tolerant extraction.
  }
  const closedWithEdit = text.match(/"answer"\s*:\s*"([\s\S]*?)"\s*,\s*"edit"\s*:/u);
  if (closedWithEdit?.[1]?.trim()) return closedWithEdit[1];
  const closed = text.match(/"answer"\s*:\s*"([\s\S]*?)"\s*\}/u);
  if (closed?.[1]?.trim()) return closed[1];
  const truncated = text.match(/^\s*\{\s*"answer"\s*:\s*"([\s\S]*)$/u);
  if (truncated?.[1]?.trim()) {
    return truncated[1].replace(TRUNCATION_MARKER_RE, '').trim();
  }
  return null;
}

/**
 * Legacy outcome-assistant messages persist the raw model envelope
 * ({"answer": "...", "edit": {...}}). Users must only ever see the answer
 * body — the machine-edit payload (block ids, replacements) stays internal.
 * Falls back to protocol scrubbing when the content is not an envelope.
 */
export function presentOutcomeAssistantAnswer(content: string): string {
  const scrubbed = scrubPresentationProtocol(content);
  if (!scrubbed) return scrubbed;
  const isEnvelope = JSON_ENVELOPE_RE.test(scrubbed) || ANSWER_ENVELOPE_START_RE.test(scrubbed);
  if (!isEnvelope) return scrubbed;
  const answer = extractOutcomeAnswerField(scrubbed);
  return answer ? scrubPresentationProtocol(answer) : scrubbed;
}
