// A streamed (NDJSON) answer the test feeds line by line: `push` enqueues one
// event, `end` closes the stream. Hand `response` to a `mockFetch` route.
export function ndjsonStream() {
  const enc = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const response = new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
  return {
    response,
    push: (evt: unknown) => controller.enqueue(enc.encode(JSON.stringify(evt) + '\n')),
    end: () => controller.close(),
  };
}
