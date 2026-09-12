/**
 * TopicStreamGate — incremental scrubber for topic-chat model deltas (P0a).
 *
 * DeepSeek-family models occasionally emit tool-call text protocols in the
 * assistant stream (`<dots_function_call>{"tool":…}` blocks, `<FILE>`-marked
 * result echoes). AgentLoop executes those calls through its text-protocol
 * parsers, but the raw deltas must never reach the user's chat: the topic UI
 * shows tool activity as dedicated rows (topic:tool-event) instead.
 *
 * The gate is an incremental state machine over streamed deltas:
 *   - plain text passes through unchanged;
 *   - a possibly-partial `<dots_function_call>` opening tag is held back
 *     until the next chunk disambiguates it;
 *   - inside a protocol block, content is swallowed until the block ends:
 *     JSON mode — after brace depth returns to zero, balanced-wait skips
 *     whitespace/extra `{…}` calls and protocol tags, and ends at the first
 *     prose character (that prose is returned to the user);
 *     echo mode — the next complete `<tag>` ends the block (swallowed).
 */

export interface TopicToolEvent {
  /** Tool display name extracted from the protocol payload, when parseable. */
  tool?: string;
  /** Raw protocol segment swallowed for this event (for the expanded view). */
  raw: string;
}

export interface TopicGateResult {
  text: string;
  toolEvents: TopicToolEvent[];
}

const OPEN_TAG = '<dots_function_call>';

export class TopicStreamGate {
  #held = '';
  #inBlock = false;
  #blockBuffer = '';
  #events: TopicToolEvent[] = [];

  /** Emit an extracted tool event to the host (overridable for tests). */
  onToolEvent: ((event: TopicToolEvent) => void) | null = null;

  private emitToolEvent(raw: string): void {
    const tools: string[] = [];
    for (const match of raw.matchAll(/\{\s*"tool"\s*:\s*"([^"]+)"/gu)) {
      const name = match[1];
      if (name !== undefined && !tools.includes(name)) tools.push(name);
    }
    for (const tool of tools) {
      this.#events.push({ tool, raw });
    }
    if (tools.length === 0) {
      this.#events.push({ raw });
    }
  }

  /**
   * Feed one streamed delta; returns text that is safe to show now.
   * Held-back ambiguous tails (`<dots_func…` prefixes, balanced-wait prose)
   * survive across pushes.
   */
  push(delta: string): string {
    this.#held += delta;
    let safe = '';
    let cursor = 0;

    while (cursor < this.#held.length) {
      if (this.#inBlock) {
        let i = cursor;
        let depth = 0;
        let blockEndedAt = -1;
        let endSwallow = -1;
        let wsStart = -1; // balanced-wait whitespace run start (returned to user on block end)
        let blockMode: 'echo' | 'json' | 'wait' = 'echo';
        while (i < this.#held.length) {
          const c: string = this.#held[i] ?? '';
          if (c === '<') {
            const close = this.#held.indexOf('>', i);
            if (close === -1) {
              // Possibly a partial tag — swallow up to i, hold the rest.
              this.#held = this.#held.slice(cursor);
              return safe;
            }
            const tag = this.#held.slice(i, close + 1);
            this.#blockBuffer += tag;
            if (tag === OPEN_TAG) {
              // Re-opened: reset tracking for the next call in the batch.
              depth = 0;
                            wsStart = -1;
              blockMode = 'echo';
              i = close + 1;
              continue;
            }
            if (tag === '<FILE>') {
              // Result-echo terminator: the block ends right after the tag.
              blockEndedAt = i;
              endSwallow = close + 1;
              break;
            }
            if (blockMode === 'wait') {
              // Wait-mode unknown tag: the block ends and the tag is returned.
              blockEndedAt = i;
              endSwallow = i;
              break;
            }
            // Echo-mode unknown tag: keep swallowing (result echo noise).
            i = close + 1;
            continue;
          }
          if (c === '{') {
            depth += 1;
                        blockMode = 'json';
            wsStart = -1;
            this.#blockBuffer += c;
            i += 1;
            continue;
          }
          if (c === '}') {
            depth -= 1;
            this.#blockBuffer += c;
            i += 1;
            if (blockMode === 'json' && depth <= 0) {
              // JSON balanced — switch to balanced-wait so trailing prose is
              // returned to the user (and a trailing <FILE> still terminates).
              blockMode = 'wait';
              wsStart = -1;
            }
            continue;
          }
          if (blockMode === 'wait') {
            // Whitespace: skip so a trailing <FILE> terminator still binds.
            if (/\s/.test(c)) { wsStart = wsStart < 0 ? i : wsStart; i += 1; continue; }
            if (c === '{') {
              // Another tool call in the same batch — back to JSON.
              depth = 1;
                            blockMode = 'json';
              wsStart = -1;
              this.#blockBuffer += c;
              i += 1;
              continue;
            }
            if (c === '<') {
              const close = this.#held.indexOf('>', i);
              if (close === -1) {
                this.#held = this.#held.slice(cursor);
                return safe;
              }
              const tag = this.#held.slice(i, close + 1);
              this.#blockBuffer += tag;
              if (tag === OPEN_TAG) {
                depth = 0; blockMode = 'json'; wsStart = -1;
                i = close + 1; continue;
              }
              if (tag === '<FILE>') { i = close + 1; continue; }
              // Other tag after balanced JSON: treat as block end.
              blockEndedAt = i;
              endSwallow = wsStart >= 0 ? wsStart : i;
              break;
            }
            // Prose: the block ends; the whitespace + prose run is returned.
            blockEndedAt = i;
            endSwallow = wsStart >= 0 ? wsStart : i;
            break;
          }
          // Echo or JSON interior text: protocol content, keep swallowing.
          this.#blockBuffer += c;
          i += 1;
        }
        if (blockEndedAt === -1) {
          // Still inside the block — swallow everything seen so far.
          this.#held = this.#held.slice(cursor);
          return safe;
        }
        this.emitToolEvent(this.#blockBuffer);
        this.#blockBuffer = '';
        this.#inBlock = false;
        cursor = endSwallow;
        continue;
      }

      const open = this.#held.indexOf('<', cursor);
      if (open === -1) {
        safe += this.#held.slice(cursor);
        this.#held = '';
        break;
      }
      safe += this.#held.slice(cursor, open);
      cursor = open;
      const close = this.#held.indexOf('>', cursor);
      if (close === -1) {
        // Ambiguous tail: could become an opening tag. Hold it.
        this.#held = this.#held.slice(cursor);
        return safe;
      }
      const tag = this.#held.slice(cursor, close + 1);
      if (tag === OPEN_TAG) {
        this.#inBlock = true;
        this.#blockBuffer = tag;
        cursor = close + 1;
        continue;
      }
      if (/^<[/]?[a-zA-Z][^<>]*>$/.test(tag)) {
        // Some other inline tag in normal prose — pass it through as text.
        safe += tag;
        cursor = close + 1;
        continue;
      }
      // A lone '<' in prose.
      safe += '<';
      cursor += 1;
    }
    this.#held = this.#held.slice(cursor);
    return safe;
  }

  /** Drain held-back text at end of stream; flushes any open protocol block as an event. */
  flush(): string {
    let tail = '';
    if (this.#inBlock) {
      this.emitToolEvent(this.#blockBuffer + this.#held);
    } else {
      tail = this.#held;
    }
    this.#held = '';
    this.#blockBuffer = '';
    this.#inBlock = false;
    return tail;
  }

  /** Events extracted so far (drained). */
  drainEvents(): TopicToolEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }
}

/** One-shot scrub for already-complete text (non-streaming paths). */
export function stripTopicProtocol(text: string): { text: string; toolEvents: TopicToolEvent[] } {
  const gate = new TopicStreamGate();
  const out = gate.push(text) + gate.flush();
  return { text: out, toolEvents: gate.drainEvents() };
}
