const PRIORITY_EMOJI = {
  urgent: ':rotating_light:',
  high: ':red_circle:',
  medium: ':large_yellow_circle:',
  low: ':large_green_circle:',
};

/**
 * Posts a ticket to the Slack channel via an Incoming Webhook.
 * Throws on failure so the caller can record it.
 */
async function sendTicketToSlack(ticket) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL is not set in .env');

  const priority = ticket.ai_priority || 'medium';
  const title = ticket.ai_title || ticket.title;

  const fields = [
    `*Client:* ${ticket.client}`,
    `*Reported by:* ${ticket.name}`,
    ticket.site_url ? `*Site:* ${ticket.site_url}` : null,
    `*Priority:* ${PRIORITY_EMOJI[priority] || ''} ${priority.toUpperCase()}`,
  ].filter(Boolean);

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🎫 #${ticket.id} — ${title}`.slice(0, 150) },
    },
    { type: 'section', text: { type: 'mrkdwn', text: fields.join('\n') } },
  ];

  if (ticket.ai_ok) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Summary*\n${ticket.ai_summary}`.slice(0, 3000) },
    });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*For devs*\n${ticket.ai_technical}`.slice(0, 3000) },
    });
  } else {
    // AI failed — send the client's own words so the ticket is never lost
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Client's description (AI summary unavailable)*\n${ticket.details}`.slice(0, 3000),
      },
    });
  }

  if (ticket.attachment_path) {
    const base = (process.env.APP_URL || '').replace(/\/$/, '');
    const link = base
      ? `${base}/uploads/${ticket.attachment_path}`
      : `(attachment saved on server: uploads/${ticket.attachment_path} — set APP_URL in .env to get clickable links)`;
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Attachment:* ${link}` },
    });
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Submitted ${ticket.created_at} UTC via ticket form` }],
  });

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `New ticket #${ticket.id}: ${title}`, blocks }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack responded ${res.status}: ${body}`);
  }
}

module.exports = { sendTicketToSlack };
