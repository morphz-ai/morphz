// Incremental lexical decoder for only the ROOT content string in reply args.
// Full JSON validation at finish remains authoritative. No model/provider/IO.
export class ReplyContentDecoder {
  constructor({ maxArgumentChars = 2_000_000 } = {}) {
    this.maxArgumentChars = maxArgumentChars;
    this.chunks = [];
    this.length = 0;
    this.stack = [];
    this.expectRootKey = false;
    this.rootKey = undefined;
    this.rootKeys = new Set();
    this.expectRootValue = false;
    this.string = undefined;
    this.escape = false;
    this.unicode = '';
    this.pendingHigh = '';
    this.contentSeen = false;
    this.contentFinished = false;
    this.finished = false;
    this.emitted = [];
  }

  push(chunk) {
    if (this.finished) throw new Error('Reply stream already finished');
    if (typeof chunk !== 'string') throw new TypeError('Argument delta must be a string');
    this.length += chunk.length;
    if (this.length > this.maxArgumentChars) throw new Error('Reply argument budget exceeded');
    this.chunks.push(chunk);
    let output = '';
    const unit = value => {
      if (this.string.role === 'key') { this.string.value += value; return; }
      if (this.string.role !== 'content') return;
      const code = value.charCodeAt(0);
      if (this.pendingHigh) {
        if (code >= 0xdc00 && code <= 0xdfff) { output += this.pendingHigh + value; this.pendingHigh = ''; return; }
        output += this.pendingHigh;
        this.pendingHigh = '';
      }
      if (code >= 0xd800 && code <= 0xdbff) this.pendingHigh = value;
      else output += value;
    };
    for (const char of chunk) {
      if (this.string) {
        if (this.unicode) {
          if (!/[0-9a-fA-F]/.test(char)) throw new Error('Invalid Unicode escape');
          this.unicode += char;
          if (this.unicode.length === 5) { unit(String.fromCharCode(parseInt(this.unicode.slice(1), 16))); this.unicode = ''; }
        } else if (this.escape) {
          this.escape = false;
          if (char === 'u') this.unicode = 'u';
          else {
            const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
            if (!Object.hasOwn(escapes, char)) throw new Error('Invalid JSON string escape');
            unit(escapes[char]);
          }
        } else if (char === '\\') this.escape = true;
        else if (char === '"') {
          if (this.string.role === 'content') { output += this.pendingHigh; this.pendingHigh = ''; this.contentFinished = true; }
          if (this.string.role === 'key') {
            this.rootKey = this.string.value;
            if (this.rootKeys.has(this.rootKey)) throw new Error('Duplicate root reply field');
            this.rootKeys.add(this.rootKey);
            this.expectRootKey = false;
          }
          this.string = undefined;
        } else {
          if (char.charCodeAt(0) < 0x20) throw new Error('Unescaped JSON control character');
          // for...of produces a whole direct Unicode code point; preserve it.
          if (char.length === 2) { unit(char[0]); unit(char[1]); } else unit(char);
        }
        continue;
      }
      if (/\s/.test(char)) continue;
      if (char === '"') {
        let role = 'ignored';
        if (this.stack.length === 1 && this.stack[0] === '{' && this.expectRootKey) role = 'key';
        else if (this.stack.length === 1 && this.expectRootValue && this.rootKey === 'content') {
          if (this.contentSeen) throw new Error('Duplicate root content field');
          role = 'content'; this.contentSeen = true;
        }
        this.string = { role, value: '' };
        this.expectRootValue = false;
      } else if (char === '{' || char === '[') {
        if (this.stack.length === 1 && this.expectRootValue && this.rootKey === 'content') throw new Error('Reply content must be a string');
        this.stack.push(char);
        if (this.stack.length === 1) this.expectRootKey = char === '{';
        this.expectRootValue = false;
      } else if (char === '}' || char === ']') {
        this.stack.pop();
        this.expectRootValue = false;
      } else if (char === ':' && this.stack.length === 1) this.expectRootValue = true;
      else if (char === ',' && this.stack.length === 1) { this.expectRootKey = true; this.rootKey = undefined; this.expectRootValue = false; }
      else if (this.stack.length === 1 && this.expectRootValue && this.rootKey === 'content') throw new Error('Reply content must be a string');
    }
    if (output) this.emitted.push(output);
    return output;
  }

  finish() {
    if (this.finished) throw new Error('Reply stream already finished');
    this.finished = true;
    const argumentsText = this.chunks.join('');
    let args;
    try { args = JSON.parse(argumentsText); } catch { throw new Error('Incomplete or malformed reply JSON'); }
    if (!args || Array.isArray(args) || typeof args !== 'object' || typeof args.content !== 'string' || !args.content.trim() || Object.keys(args).some(key => !['content', 'annotations'].includes(key))) {
      throw new Error('Invalid reply control body');
    }
    const streamed = this.emitted.join('');
    if (!this.contentSeen || !this.contentFinished || streamed !== args.content) throw new Error('Streamed content does not exactly match final reply');
    return { content: args.content, argumentsText, annotations: args.annotations };
  }
}

/** A normalized full event stream, not a text-only filter: real tool events and
 * ordinary text pass through exactly. Only reserved reply control events are
 * transformed into TextDelta. A host-only callback can preserve the RAW stream
 * for replay/inspection; it must not publish raw reply args as public text. */
export class ReplyStreamNormalizer {
  constructor({ enabled = false, typedInfer = false, onRawEvent, ...decoderOptions } = {}) {
    this.enabled = enabled && !typedInfer;
    this.decoderOptions = decoderOptions;
    this.onRawEvent = onRawEvent;
    this.tools = new Map();
    this.replyStarted = false;
    this.ordinaryTextSeen = false;
  }

  push(event) {
    if (!this.enabled) return [event];
    this.onRawEvent?.(event);
    const wireKinds = { text_delta: 'TextDelta', tool_call_started: 'ToolCallStarted', tool_arguments_delta: 'ToolArgumentsDelta', tool_call_completed: 'ToolCallCompleted', completed: 'Completed' };
    const type = event.type ?? wireKinds[event.kind];
    if (type === 'TextDelta' && event.text.trim()) {
      if (this.replyStarted) throw new Error('reply cannot mix with ordinary content');
      this.ordinaryTextSeen = true;
    }
    if (type === 'ToolCallStarted') {
      if (this.tools.has(event.index)) throw new Error('Duplicate tool stream start');
      if (this.replyStarted || event.name === 'reply' && (this.tools.size || this.ordinaryTextSeen)) throw new Error('reply must be sole call with no ordinary content');
      if (event.name === 'reply') this.replyStarted = true;
      this.tools.set(event.index, { id: event.id, name: event.name,
        ...(event.name === 'reply' ? { decoder: new ReplyContentDecoder(this.decoderOptions) } : {}) });
      return event.name === 'reply' ? [] : [event];
    }
    if (type === 'ToolArgumentsDelta') {
      const tool = this.tools.get(event.index);
      if (!tool) throw new Error('Tool arguments arrived before complete tool identity');
      if (!tool.decoder) return [event];
      const text = tool.decoder.push(event.delta);
      return text ? [event.kind ? { kind: 'text_delta', text } : { type: 'TextDelta', text }] : [];
    }
    if (type === 'ToolCallCompleted') {
      const tool = this.tools.get(event.index);
      if (!tool) throw new Error('Unknown completed tool');
      if (tool.decoder) tool.reply = tool.decoder.finish();
      return tool.decoder ? [] : [event];
    }
    if (type === 'Completed' && this.replyStarted && [...this.tools.values()].some(tool => tool.decoder && !tool.reply)) throw new Error('Reply stream completed without validated control body');
    return [event];
  }
}
