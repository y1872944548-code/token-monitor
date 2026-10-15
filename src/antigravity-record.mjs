// Experimental local generation metadata layout; see docs/CLIENTS.md for evidence.
// Decode numeric usage and the embedded generation timestamp only. Never decode text.
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
function fields(data) {
  let at = 0;
  function integer() {
    let value = 0n;
    for (let n = 0; n < 10; n++) {
      if (at >= data.length) throw new Error('Truncated protobuf');
      const byte = data[at++];
      if (n === 9 && byte > 1) throw new Error('Invalid protobuf integer');
      value |= BigInt(byte & 127) << BigInt(7 * n);
      if (!(byte & 128)) return value;
    }
    throw new Error('Invalid protobuf integer');
  }
  const result = new Map();
  while (at < data.length) {
    const tag = integer(), number = Number(tag >> 3n), wire = Number(tag & 7n);
    if (number < 1 || number > 536870911 || result.has(number)) throw new Error('Unsupported protobuf layout');
    if (wire === 0) result.set(number, integer());
    else {
      const length = wire === 1 ? 8 : wire === 5 ? 4 : wire === 2 ? Number(integer()) : -1;
      if (!Number.isSafeInteger(length) || length < 0 || length > data.length - at) throw new Error('Invalid protobuf field');
      result.set(number, data.subarray(at, at + length)); at += length;
    }
  }
  return result;
}
function message(value) { if (!(value instanceof Uint8Array)) throw new Error('Missing metadata envelope'); return fields(value); }
function counter(value) { if (typeof value !== 'bigint' || value < 0n || value > MAX) throw new Error('Invalid usage counter'); return Number(value); }
export function parseAntigravityRecord(data) {
  if (!(data instanceof Uint8Array) || data.length > 1024 * 1024) throw new Error('Metadata record exceeds limit');
  const root = fields(data);
  if (!root.has(1)) return null;
  const chat = message(root.get(1));
  if (!chat.has(4)) return null;
  const usage = message(chat.get(4)), generation = message(chat.get(9)), stamp = message(generation.get(4));
  const seconds = counter(stamp.get(1)), nanos = stamp.has(2) ? counter(stamp.get(2)) : 0;
  if (seconds <= 0 || seconds > 253402300799 || nanos > 999999999) throw new Error('Unsupported event timestamp');
  // Field 1 is a model enum, never a token count. Field 3 is aggregate output.
  // Recorded field 9/10 naming differs between reverse-engineered readers;
  // use their sum only, without inventing a reasoning/visible breakdown.
  const splitOutput = usage.has(9) && usage.has(10) ? counter(usage.get(9)) + counter(usage.get(10)) : null;
  const output = usage.has(3) ? counter(usage.get(3)) : splitOutput;
  if (output === null || (splitOutput !== null && splitOutput !== output)) throw new Error('Unsupported output accounting');
  const fresh = counter(usage.get(2)), cached = usage.has(5) ? counter(usage.get(5)) : 0;
  const input = fresh + cached, total = input + output;
  if (!Number.isSafeInteger(total)) throw new Error('Usage overflow');
  const response = usage.get(11);
  return { time: seconds * 1000 + Math.floor(nanos / 1000000),
    responseId: response instanceof Uint8Array && response.length <= 256 ? Buffer.from(response).toString('hex') : null,
    usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: null, total_tokens: total } };
}
