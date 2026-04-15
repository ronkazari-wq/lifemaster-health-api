/**
 * Session Consumer
 * Streams session events, watches for custom tool calls, executes tools, sends results back
 */

const Anthropic = require("@anthropic-ai/sdk");
const { getSessionOwner } = require("./session-manager");
const { supabase } = require("./supabaseClient");
const { executeToolWithUserScope } = require("./tool-executor");
const pool = require("./consumer-pool");

// Get API key - fallback to .env file if not in process.env
let apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  try {
    const fs = require('fs');
    const path = require('path');
    const envPath = path.join(__dirname, '.env');
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const match = envContent.match(/ANTHROPIC_API_KEY=(.+)/);
    if (match) {
      apiKey = match[1].trim();
    }
  } catch (err) {
    // Ignore
  }
}

const client = new Anthropic({
  apiKey,
});

class SessionConsumer {
  constructor(sessionId, userId, triggerType = 'manual') {
    this.sessionId = sessionId;
    this.userId = userId;
    this.triggerType = triggerType;
    this.eventsById = {};
    this.toolUseEvents = {};
    this.agentMessages = [];
  }

  /**
   * Main entry point: Start streaming and handling events
   */
  async start() {
    console.log(
      `\n📡 [CONSUMER] Starting for session ${this.sessionId}, user ${this.userId}`
    );

    try {
      // Verify user_id from session (safety check)
      const verifiedUserId = await getSessionOwner(this.sessionId);
      if (verifiedUserId !== this.userId) {
        throw new Error(
          `User ID mismatch: got ${this.userId}, expected ${verifiedUserId}`
        );
      }

      // Open stream and start consuming events
      const stream = await client.beta.sessions.events.stream(
        this.sessionId
      );

      for await (const event of stream) {
        // Store all events by ID for reference
        if (event.id) {
          this.eventsById[event.id] = event;
        }

        console.log(`   Event: ${event.type}`);

        // Track agent messages
        if (event.type === "agent.message") {
          this.agentMessages.push(event);
        }

        // Track custom tool use requests
        if (event.type === "agent.custom_tool_use") {
          this.toolUseEvents[event.id] = {
            name: event.name,
            input: event.input,
          };
          console.log(`   → Custom tool requested: ${event.name}`);
        }

        // Handle session status (pause for tool confirmation, or completion)
        if (event.type === "session.status_idle") {
          const stopReason = event.stop_reason?.type;

          if (stopReason === "requires_action") {
            console.log(`   → Session requires action for tools`);
            await this.handleToolCalls(event.stop_reason.event_ids);
          } else if (stopReason === "end_turn") {
            console.log(`   → Session complete (end_turn)`);
            await this.handleCompletion();
            break; // Exit stream loop
          }
        }
      }

      console.log(
        `✅ [CONSUMER] Completed for session ${this.sessionId}`
      );
    } catch (error) {
      console.error(
        `❌ [CONSUMER] Error for session ${this.sessionId}:`,
        error.message
      );
      throw error;
    } finally {
      // Always unregister from pool
      pool.unregisterConsumer(this.sessionId);
    }
  }

  /**
   * Handle tool calls: execute tools and send results back
   */
  async handleToolCalls(eventIds) {
    console.log(`   Handling ${eventIds.length} tool call(s)`);

    for (const eventId of eventIds) {
      const toolUseEvent = this.toolUseEvents[eventId];

      if (!toolUseEvent) {
        console.warn(
          `   ⚠️  Tool use event not found for ${eventId}, skipping`
        );
        continue;
      }

      const { name: toolName, input: toolInput } = toolUseEvent;

      try {
        console.log(`   Executing tool: ${toolName}`);
        const result = await executeToolWithUserScope(
          toolName,
          toolInput,
          this.userId
        );

        console.log(`   ✓ Tool result: ${result.substring(0, 100)}...`);

        // Send result back to Anthropic
        await client.beta.sessions.events.send(this.sessionId, {
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: eventId,
              content: [
                {
                  type: "text",
                  text: result,
                },
              ],
            },
          ],
        });

        console.log(`   ✓ Result sent to Anthropic`);
      } catch (error) {
        console.error(`   ❌ Tool execution failed: ${error.message}`);

        // Send error as tool result
        await client.beta.sessions.events.send(this.sessionId, {
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: eventId,
              content: [
                {
                  type: "text",
                  text: `Tool error: ${error.message}`,
                },
              ],
            },
          ],
        });
      }
    }
  }

  /**
   * Handle session completion: send WhatsApp + persist to DB
   */
  async handleCompletion() {
    try {
      // Extract final message from agent
      let finalMessage = "";
      if (this.agentMessages.length > 0) {
        const lastMessage = this.agentMessages[this.agentMessages.length - 1];
        if (lastMessage.content && Array.isArray(lastMessage.content)) {
          const textParts = lastMessage.content
            .filter(block => block.type === 'text' && block.text)
            .map(block => block.text);
          if (textParts.length > 0) {
            finalMessage = textParts.join('\n');
          }
        }
      }

      if (!finalMessage) {
        console.log(`   ⚠️  No agent message to send`);
        return;
      }

      // Send to WhatsApp if user has a phone number
      try {
        const { data: user } = await supabase
          .from("users")
          .select("phone_number")
          .eq("id", this.userId)
          .single();

        if (user?.phone_number) {
          const { sendWhatsAppMessage } = require("./whatsapp");
          await sendWhatsAppMessage(`whatsapp:${user.phone_number}`, finalMessage);
          console.log(`   ✓ WhatsApp sent to ${user.phone_number}`);
        } else {
          console.warn(`   ⚠️  No phone number for user ${this.userId}`);
        }
      } catch (waErr) {
        console.error(`   ❌ WhatsApp send failed:`, waErr.message);
      }

      // Persist to agent_decisions
      const { error } = await supabase
        .from("agent_decisions")
        .insert({
          user_id: this.userId,
          proposal_text: finalMessage,
          rationale: "Autonomous decision from managed agent",
          decision_type: "autonomous",
          trigger_type: this.triggerType,
          decision_payload: {},
          status: "granted",
          scope: "health",
          is_final: true,
        });

      if (error) {
        console.error(`   ❌ Failed to persist decision:`, error.message);
      } else {
        console.log(`   ✓ Decision persisted`);
      }
    } catch (error) {
      console.error(`❌ [CONSUMER] Completion handling failed:`, error.message);
    }
  }
}

module.exports = SessionConsumer;
