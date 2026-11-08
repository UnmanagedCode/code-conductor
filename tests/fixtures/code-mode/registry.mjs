// A small tool registry for tests/mcp-client-generator.test.mjs that exercises
// every schema construct the client generator maps (src/mcp/client/typeModel.ts).
// Its rendering is snapshotted in ./expected/, so the snapshot does not move
// when a real tool's description or schema does.

const str = { type: 'string' };
const int = { type: 'integer' };

export const FIXTURE_TOOLS = [
  {
    name: 'make_thing',
    description: 'Make a thing.\nA second line with a """ triple quote, a */ comment end and a \\ backslash.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-z]+$', description: 'The thing\'s name.' },
        count: { type: 'integer', minimum: 1, maximum: 9, default: 3, description: 'How many.' },
        label: { type: ['string', 'null'], description: 'A label, or null to clear it.' },
        kind: { type: 'string', enum: ['small', 'large'], description: 'Which kind.' },
        extra: { type: 'object', description: 'Free-form {key: value} pairs.' },
        from: { type: 'string', description: 'Where it comes from.' },
        tags: { type: 'array', items: str },
      },
      required: ['name'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        id: str,
        note: str,
        size: { type: ['integer', 'null'] },
        owner: {
          type: ['object', 'null'],
          properties: { name: str },
          required: ['name'],
          additionalProperties: false,
        },
        state: { enum: ['open', 'closed', null] },
        ok: { const: true },
        parts: { type: 'array', items: { type: 'object', properties: { at: int }, required: ['at'], additionalProperties: false } },
        scores: { type: 'object', additionalProperties: { type: 'number' } },
        meta: { type: 'object', additionalProperties: true, description: 'Pass-through metadata.' },
        pin: { type: ['string', 'number', 'boolean', 'null'] },
        policy: { anyOf: [{ enum: ['allow', 'deny'] }, { type: 'object', properties: { limit: int }, required: ['limit'], additionalProperties: false }] },
        input: { description: 'Anything at all.' },
      },
      required: ['id', 'size', 'owner', 'state', 'ok', 'parts', 'scores', 'meta', 'pin', 'policy', 'input'],
      additionalProperties: false,
    },
  },
  {
    name: 'pick_one',
    description: 'Pick one.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: {
      type: 'object',
      additionalProperties: true,
      anyOf: [
        { type: 'object', properties: { picked: { const: 'a' }, a: str }, required: ['picked', 'a'], additionalProperties: false },
        { type: 'object', properties: { picked: { const: 'b' } }, required: ['picked'], additionalProperties: false },
      ],
    },
  },
];
