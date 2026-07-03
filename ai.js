const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic(); // reads ANTHROPIC_API_KEY (or an `ant auth login` profile)

const SYSTEM_PROMPT = `You turn support requests written by non-technical website clients into
clear tickets for a web development team.

The client may write vaguely ("the page is broken", "it looks weird on my phone").
Translate that into precise technical language a developer can act on:
- Name the likely area (frontend layout, form handling, DNS/hosting, CMS content, performance, etc.)
- Describe expected vs. actual behavior when it can be inferred
- Keep every concrete fact the client gave (URLs, browsers, devices, error text)
- Do not invent facts. If something is unknown, say what the developer should ask or check.

Assign priority: "urgent" only for a site fully down or losing money/data,
"high" for broken core functionality, "medium" for partial issues, "low" for cosmetic requests.`;

const TICKET_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'Short, technical ticket title (max ~80 chars)',
    },
    summary: {
      type: 'string',
      description: 'One-paragraph plain summary of what the client reported',
    },
    technical_description: {
      type: 'string',
      description:
        'The issue rewritten in technical developer language: likely area of the codebase/stack, expected vs actual behavior, and suggested first debugging steps',
    },
    priority: {
      type: 'string',
      enum: ['low', 'medium', 'high', 'urgent'],
    },
  },
  required: ['title', 'summary', 'technical_description', 'priority'],
  additionalProperties: false,
};

/**
 * Returns { title, summary, technical_description, priority }.
 * Throws on API failure — caller decides the fallback.
 */
async function summarizeTicket(ticket) {
  const userContent = [
    `Client contact: ${ticket.name}`,
    `Client/company: ${ticket.client}`,
    `Site/URL: ${ticket.site_url || '(not provided)'}`,
    `Subject given by client: ${ticket.title}`,
    ticket.attachment_url ? 'The client attached a screenshot/video (not shown here).' : '',
    '',
    'Problem description from the client:',
    ticket.details,
  ].join('\n');

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 2048,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    output_config: { format: { type: 'json_schema', schema: TICKET_SCHEMA } },
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error(`No text in AI response (stop_reason: ${response.stop_reason})`);
  return JSON.parse(textBlock.text);
}

module.exports = { summarizeTicket };
