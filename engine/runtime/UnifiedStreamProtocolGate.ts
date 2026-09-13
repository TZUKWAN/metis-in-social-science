/**
 * Shared incremental presentation gate for model text protocols.
 *
 * Provider/model gateways may serialize tool calls into assistant text. This
 * gate is the renderer boundary: protocol bytes are held and swallowed across
 * arbitrary chunk boundaries, while ordinary prose/markdown passes through.
 * Tool execution lifecycle remains sourced from AgentLoop hooks; events here
 * are only protocol observations and must not be treated as execution proof.
 */

export interface UnifiedToolEvent {
  tool?: string;
  raw: string;
  protocol?: 'dots_function_call' | 'tool_call' | 'dsml';
}

export interface UnifiedGateResult {
  text: string;
  toolEvents: UnifiedToolEvent[];
}

type BlockMode = 'dots' | 'tool' | 'dsml';

const DOTS_OPEN = '<dots_function_call>';
const TOOL_OPEN = /^<\s*(tool_call|tool_calls)\s*>$/iu;
const DSML_OPEN = /^<\s*[｜|]+\s*DSML\s*[｜|]+\s*(tool_calls|invoke)\b[^>]*>$/iu;
const DSML_TOOL_CALLS_CLOSE = /<\s*\/\s*[｜|]*\s*DSML\s*[｜|]*\s*tool_calls\s*>/iu;
const DSML_INVOKE_CLOSE = /<\s*\/\s*[｜|]*\s*DSML\s*[｜|]*\s*invoke\s*>/iu;

function protocolFor(mode: BlockMode): UnifiedToolEvent['protocol'] {
  return mode === 'dots' ? 'dots_function_call' : mode === 'tool' ? 'tool_call' : 'dsml';
}

function extractToolNames(raw: string): string[] {
  const names: string[] = [];
  const add = (value: string | undefined) => {
    const name = value?.trim();
    if (name && !names.includes(name)) names.push(name);
  };
  for (const match of raw.matchAll(/"tool"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/giu)) add(match[1]);
  for (const match of raw.matchAll(/"(?:name|tool_name)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/giu)) add(match[1]);
  for (const match of raw.matchAll(/<\s*[｜|]+\s*DSML\s*[｜|]+\s*invoke\s+name\s*=\s*"([^"]+)"/giu)) add(match[1]);
  return names;
}

function isProtocolOpening(tag: string): { mode: BlockMode; root?: 'tool_call' | 'tool_calls' | 'invoke' } | null {
  if (tag === DOTS_OPEN) return { mode: 'dots' };
  const tool = tag.match(TOOL_OPEN);
  if (tool) return { mode: 'tool', root: tool[1]?.toLowerCase() === 'tool_calls' ? 'tool_calls' : 'tool_call' };
  const dsml = tag.match(DSML_OPEN);
  if (dsml) {
    const root = dsml[1]?.toLowerCase() === 'invoke' ? 'invoke' : 'tool_calls';
    return { mode: 'dsml', root };
  }
  return null;
}

export class UnifiedStreamProtocolGate {
  #held = '';
  #inBlock = false;
  #blockMode: BlockMode | null = null;
  #blockRoot: 'tool_call' | 'tool_calls' | 'invoke' | null = null;
  #blockBuffer = '';
  #events: UnifiedToolEvent[] = [];
  #dotsDepth = 0;
  #dotsWait = false;
  #dotsWhitespaceStart = -1;

  onToolEvent: ((event: UnifiedToolEvent) => void) | null = null;

  #emitToolEvent(raw: string, protocol: UnifiedToolEvent['protocol']): void {
    const names = extractToolNames(raw);
    if (names.length === 0) {
      const event: UnifiedToolEvent = { raw, ...(protocol ? { protocol } : {}) };
      this.#events.push(event);
      this.onToolEvent?.(event);
      return;
    }
    for (const tool of names) {
      const event: UnifiedToolEvent = { tool, raw, ...(protocol ? { protocol } : {}) };
      this.#events.push(event);
      this.onToolEvent?.(event);
    }
  }

  #resetBlock(): void {
    this.#inBlock = false;
    this.#blockMode = null;
    this.#blockRoot = null;
    this.#blockBuffer = '';
    this.#dotsDepth = 0;
    this.#dotsWait = false;
    this.#dotsWhitespaceStart = -1;
  }

  #enterBlock(opening: { mode: BlockMode; root?: 'tool_call' | 'tool_calls' | 'invoke' }, tag: string): void {
    this.#inBlock = true;
    this.#blockMode = opening.mode;
    this.#blockRoot = opening.root ?? null;
    this.#blockBuffer = tag;
    this.#dotsDepth = 0;
    this.#dotsWait = false;
    this.#dotsWhitespaceStart = -1;
  }

  #consumeDots(cursor: number): { end: number; swallow: number } | null {
    let index = cursor;
    while (index < this.#held.length) {
      const character = this.#held[index] ?? '';
      if (character === '<') {
        const close = this.#held.indexOf('>', index);
        if (close < 0) return null;
        const tag = this.#held.slice(index, close + 1);
        if (tag === DOTS_OPEN) {
          this.#blockBuffer += tag;
          this.#dotsDepth = 0;
          this.#dotsWait = false;
          this.#dotsWhitespaceStart = -1;
          index = close + 1;
          continue;
        }
        if (tag === '<FILE>') {
          this.#blockBuffer += tag;
          return { end: index, swallow: close + 1 };
        }
        if (this.#dotsWait) {
          // Unknown tags after a balanced JSON object are prose markup and must
          // remain visible; the whitespace before them is part of the answer.
          return { end: index, swallow: this.#dotsWhitespaceStart >= 0 ? this.#dotsWhitespaceStart : index };
        }
        this.#blockBuffer += tag;
        index = close + 1;
        continue;
      }
      if (character === '{') {
        this.#dotsDepth += 1;
        this.#dotsWait = false;
        this.#dotsWhitespaceStart = -1;
        this.#blockBuffer += character;
        index += 1;
        continue;
      }
      if (character === '}') {
        this.#dotsDepth -= 1;
        this.#blockBuffer += character;
        index += 1;
        if (this.#dotsDepth <= 0) {
          this.#dotsDepth = 0;
          this.#dotsWait = true;
          this.#dotsWhitespaceStart = -1;
        }
        continue;
      }
      if (this.#dotsWait) {
        if (/\s/u.test(character)) {
          if (this.#dotsWhitespaceStart < 0) this.#dotsWhitespaceStart = index;
          index += 1;
          continue;
        }
        if (character === '{') {
          this.#dotsDepth = 1;
          this.#dotsWait = false;
          this.#dotsWhitespaceStart = -1;
          this.#blockBuffer += character;
          index += 1;
          continue;
        }
        return { end: index, swallow: this.#dotsWhitespaceStart >= 0 ? this.#dotsWhitespaceStart : index };
      }
      this.#blockBuffer += character;
      index += 1;
    }
    return null;
  }

  #consumeTaggedBlock(cursor: number): { end: number; swallow: number } | null {
    const mode = this.#blockMode;
    if (mode === 'dsml') {
      const closePattern = this.#blockRoot === 'tool_calls' ? DSML_TOOL_CALLS_CLOSE : DSML_INVOKE_CLOSE;
      const match = closePattern.exec(this.#held.slice(cursor));
      if (!match || match.index === undefined) return null;
      const end = cursor + match.index;
      const swallow = end + match[0].length;
      return { end, swallow };
    }

    const root = this.#blockRoot === 'tool_calls' ? 'tool_calls' : 'tool_call';
    const closePattern = root === 'tool_calls' ? /<\s*\/\s*tool_calls\s*>/iu : /<\s*\/\s*tool_call\s*>/iu;
    const rest = this.#held.slice(cursor);
    const close = closePattern.exec(rest);
    if (close && close.index !== undefined) {
      const end = cursor + close.index;
      return { end, swallow: end + close[0].length };
    }
    // A complete JSON payload without an explicit closing tag is still a
    // protocol block. If prose follows it, release that prose; otherwise keep
    // holding until the next chunk so a split closing tag cannot leak.
    const jsonEnd = this.#findBalancedJsonEnd(cursor);
    if (jsonEnd >= 0) {
      let index = jsonEnd;
      while (index < this.#held.length && /\s/u.test(this.#held[index] ?? '')) index += 1;
      if (index < this.#held.length && this.#held[index] !== '<') return { end: index, swallow: index };
    }
    return null;
  }

  #findBalancedJsonEnd(start: number): number {
    const first = this.#held.indexOf('{', start);
    if (first < 0) return -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = first; index < this.#held.length; index += 1) {
      const character = this.#held[index] ?? '';
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') { inString = true; continue; }
      if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    return -1;
  }

  push(delta: string): string {
    if (delta) this.#held += delta;
    let safe = '';
    let cursor = 0;

    while (cursor < this.#held.length) {
      if (this.#inBlock) {
        const result = this.#blockMode === 'dots'
          ? this.#consumeDots(cursor)
          : this.#consumeTaggedBlock(cursor);
        if (!result) {
          this.#blockBuffer += this.#held.slice(cursor);
          this.#held = '';
          return safe;
        }
        this.#blockBuffer += this.#held.slice(cursor, result.end);
        this.#emitToolEvent(this.#blockBuffer, protocolFor(this.#blockMode!));
        this.#held = this.#held.slice(result.swallow);
        cursor = 0;
        this.#resetBlock();
        continue;
      }

      const open = this.#held.indexOf('<', cursor);
      if (open < 0) {
        safe += this.#held.slice(cursor);
        this.#held = '';
        return safe;
      }
      safe += this.#held.slice(cursor, open);
      const close = this.#held.indexOf('>', open);
      if (close < 0) {
        this.#held = this.#held.slice(open);
        return safe;
      }
      const tag = this.#held.slice(open, close + 1);
      const opening = isProtocolOpening(tag);
      if (opening) {
        this.#held = this.#held.slice(close + 1);
        cursor = 0;
        this.#enterBlock(opening, tag);
        continue;
      }
      // Non-protocol HTML/Markdown tags and ordinary comparison operators pass
      // through unchanged. Only the protocol opening tags above are special.
      safe += tag;
      cursor = close + 1;
    }
    this.#held = this.#held.slice(cursor);
    return safe;
  }

  flush(): string {
    let tail = '';
    if (this.#inBlock) {
      this.#blockBuffer += this.#held;
      this.#emitToolEvent(this.#blockBuffer, protocolFor(this.#blockMode!));
    } else {
      tail = this.#held;
    }
    this.#held = '';
    this.#resetBlock();
    return tail;
  }

  drainEvents(): UnifiedToolEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  sanitizeComplete(text: string): string {
    if (!text) return text;
    const out = this.push(text) + this.flush();
    const hadProtocol = this.#events.length > 0;
    if (!hadProtocol) return out;
    return out
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

export function sanitizeUnifiedProtocolText(text: string): string {
  return new UnifiedStreamProtocolGate().sanitizeComplete(text);
}

export function stripUnifiedProtocol(text: string): UnifiedGateResult {
  const gate = new UnifiedStreamProtocolGate();
  const output = gate.push(text) + gate.flush();
  return { text: output, toolEvents: gate.drainEvents() };
}
