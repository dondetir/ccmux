import { scaleUsage } from "./models.js";

// Native pass-through stream: usage fields in message_start/message_delta are
// scaled by the context factor (so Claude Code's context tracking matches the
// serving model). Merged usage reported once via onUsage for cost tracking.
// Every other frame passes through BYTE-IDENTICAL; thinking signatures must not be re-serialized.
export async function* rewriteNativeStream(
  upstream: ReadableStream<Uint8Array>,
  factor: number,
  onUsage: (usage: any) => void = () => {},
  onAbort: () => void = () => {}, // called when upstream dies mid-stream
): AsyncGenerator<string> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const merged: any = {};

  const process = (frame: string): string => {
    if (!frame.includes('"usage"')) return frame;
    // locate the data field; frames may or may not carry an `event:` line
    const at = frame.startsWith("data: ") ? 0 : frame.indexOf("\ndata: ") + 1;
    if (at === 0 && !frame.startsWith("data: ")) return frame; // no data field
    const split = at + "data: ".length;
    try {
      const evt = JSON.parse(frame.slice(split));
      const usage =
        evt.type === "message_start" ? evt.message?.usage : evt.type === "message_delta" ? evt.usage : null;
      if (!usage) return frame;
      Object.assign(merged, usage); // raw values, assigned before scaling
      scaleUsage(usage, factor);
      return frame.slice(0, split) + JSON.stringify(evt);
    } catch {
      return frame; // not parseable, pass through untouched
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) yield process(frame) + "\n\n";
    }
  } catch {
    onAbort();
  }
  if (buf) yield process(buf);
  if (Object.keys(merged).length) onUsage(merged);
}
