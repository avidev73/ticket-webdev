const { GoogleGenAI, Type } = require('@google/genai');

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

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

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: {
      type: Type.STRING,
      description: 'Short, technical ticket title (max ~80 chars)',
    },
    summary: {
      type: Type.STRING,
      description: 'One-paragraph plain summary of what the client reported',
    },
    technical_description: {
      type: Type.STRING,
      description:
        'The issue rewritten in technical developer language: likely area of the codebase/stack, expected vs actual behavior, and suggested first debugging steps',
    },
    priority: {
      type: Type.STRING,
      enum: ['low', 'medium', 'high', 'urgent'],
    },
  },
  required: ['title', 'summary', 'technical_description', 'priority'],
};

/**
 * Returns { title, summary, technical_description, priority }.
 * Throws on API failure — caller decides the fallback.
 */
async function summarizeTicket(ticket) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: userContent,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  if (!response.text) throw new Error('Empty response from Gemini');
  return JSON.parse(response.text);
}

module.exports = { summarizeTicket };
