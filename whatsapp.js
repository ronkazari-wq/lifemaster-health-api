/**
 * WhatsApp Handler
 * Receives messages from Twilio, routes to Anthropic agent, replies back.
 *
 * Flow:
 *   Twilio webhook → lookup user → send to agent session → stream → reply
 */

require("dotenv").config();
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");
const { supabase } = require("./supabaseClient");
const sessionManager = require("./session-manager");
const { executeToolWithUserScope } = require("./tool-executor");

// ── Clients ───────────────────────────────────────────────────────────────────

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

let apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  try {
    const fs = require("fs"), path = require("path");
    const env = fs.readFileSync(path.join(__dirname, ".env"), "utf-8");
    const m = env.match(/ANTHROPIC_API_KEY=(.+)/);
    if (m) apiKey = m[1].trim();
  } catch (_) {}
}
const anthropic = new Anthropic({ apiKey });

// ── Phone → user_id lookup ────────────────────────────────────────────────────

/**
 * Twilio sends phone as "whatsapp:+972501234567".
 * We strip the prefix and match against public.users.phone_number.
 */
async function getUserIdByPhone(rawFrom) {
  // Normalize: "whatsapp:+972501234567" → "0501234567" (Israeli local) and "+972501234567"
  const e164 = rawFrom.replace("whatsapp:", "").trim(); // e.g. +972501234567

  const { data, error } = await supabase
    .from("users")                          // public.users
    .select("id, phone_number")
    .or(`phone_number.eq.${e164},phone_number.eq.0${e164.slice(4)}`) // try +972... and 05...
    .limit(1)
    .single();

  if (error || !data) return null;
  return data.id;
}

// ── WhatsApp formatter ────────────────────────────────────────────────────────

/**
 * Convert agent Markdown output to WhatsApp-safe text.
 *
 * WhatsApp supports: *bold*, _italic_, ~strike~, ```code```
 * WhatsApp does NOT support: ## headers, --- dividers, > blockquotes, **bold**
 */
function formatForWhatsApp(text) {
  return text
    // ## Header → *Header* (WhatsApp bold)
    .replace(/^#{1,3}\s+(.+)$/gm, "*$1*")
    // **bold** → *bold*
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    // --- dividers → blank line
    .replace(/^---+$/gm, "")
    // > blockquote → keep text, remove marker
    .replace(/^>\s*/gm, "")
    // Remove backtick code fences
    .replace(/```[\s\S]*?```/g, "")
    // Inline code
    .replace(/`(.+?)`/g, "$1")
    // Collapse 3+ blank lines → 2
    .replace(/\n{3,}/g, "\n\n")
    // Trim
    .trim();
}

/**
 * Split long messages into chunks ≤ 1500 chars (safe for WhatsApp UX).
 * Splits on double newlines to keep paragraphs intact.
 */
function splitIntoChunks(text, maxLen = 1500) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if ((current + "\n\n" + para).length > maxLen && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks;
}

// ── Twilio sender ─────────────────────────────────────────────────────────────

async function sendWhatsAppMessage(to, body) {
  const from = process.env.TWILIO_WHATSAPP_FROM; // e.g. "whatsapp:+14155238886"
  const chunks = splitIntoChunks(formatForWhatsApp(body));

  for (const chunk of chunks) {
    await twilioClient.messages.create({ from, to, body: chunk });
    // Small delay between chunks to preserve order
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 300));
  }
}

// ── Agent session runner ──────────────────────────────────────────────────────

/**
 * Send a message to the user's Anthropic session and stream until end_turn.
 * Returns the final agent text.
 */
async function runAgentSession(sessionId, userId, userMessage) {
  // Send user message to session
  await anthropic.beta.sessions.events.send(sessionId, {
    events: [{
      type: "user.message",
      content: [{ type: "text", text: userMessage }],
    }],
  });

  // Stream events until end_turn
  const toolUseEvents = {};
  const agentMessages = [];

  const stream = await anthropic.beta.sessions.events.stream(sessionId);

  for await (const event of stream) {
    if (event.type === "agent.custom_tool_use") {
      toolUseEvents[event.id] = { name: event.name, input: event.input };
    }

    if (event.type === "agent.message") {
      agentMessages.push(event);
    }

    if (event.type === "session.status_idle") {
      const stopReason = event.stop_reason?.type;

      if (stopReason === "requires_action") {
        // Execute each tool and send results back
        for (const eventId of event.stop_reason.event_ids) {
          const toolUse = toolUseEvents[eventId];
          if (!toolUse) continue;

          try {
            const result = await executeToolWithUserScope(toolUse.name, toolUse.input, userId);
            await anthropic.beta.sessions.events.send(sessionId, {
              events: [{
                type: "user.custom_tool_result",
                custom_tool_use_id: eventId,
                content: [{ type: "text", text: result }],
              }],
            });
          } catch (err) {
            await anthropic.beta.sessions.events.send(sessionId, {
              events: [{
                type: "user.custom_tool_result",
                custom_tool_use_id: eventId,
                content: [{ type: "text", text: `Tool error: ${err.message}` }],
              }],
            });
          }
        }
      } else if (stopReason === "end_turn") {
        break;
      }
    }
  }

  // Extract final text from last agent message
  if (agentMessages.length === 0) return "✅ בוצע";

  const last = agentMessages[agentMessages.length - 1];
  return last.content
    ?.filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n") || "✅ בוצע";
}

// ── Main handler ──────────────────────────────────────────────────────────────

/**
 * Handle an incoming WhatsApp message.
 * Called by the webhook endpoint in index.js.
 *
 * @param {string} from  - e.g. "whatsapp:+972501234567"
 * @param {string} body  - the user's message text
 */
async function handleIncomingMessage(from, body) {
  console.log(`\n📱 [WHATSAPP] Message from ${from}: "${body.substring(0, 60)}"`);

  // 1. Lookup user
  const userId = await getUserIdByPhone(from);
  if (!userId) {
    console.warn(`   ⚠️  No user found for ${from}`);
    await sendWhatsAppMessage(from, "לא נמצא חשבון משויך למספר הזה. פנה לתמיכה.");
    return;
  }
  console.log(`   User: ${userId}`);

  // 2. Get or create session
  const sessionId = await sessionManager.getOrCreateSession(userId);
  console.log(`   Session: ${sessionId}`);

  // 3. Run agent and get response
  const agentResponse = await runAgentSession(sessionId, userId, body);
  console.log(`   Agent response: ${agentResponse.substring(0, 80)}...`);

  // 4. Send back to WhatsApp
  await sendWhatsAppMessage(from, agentResponse);
  console.log(`   ✅ Reply sent to ${from}`);
}

module.exports = { handleIncomingMessage, sendWhatsAppMessage, formatForWhatsApp };
