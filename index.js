// ============================================================
// Dependencies
// ============================================================
const http = require('http');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');
const OpenAI = require('openai');
require('dotenv').config();

// ============================================================
// Local Modules
// ============================================================
const config = require('./config');
const HistoryManager = require('./history');

// ============================================================
// State & Initialization
// ============================================================

// Chat history manager for conversation context
let historyManager;
if (config.aiBot.memory?.enabled) {
  historyManager = new HistoryManager(config.aiBot.memory.limit);
}

// Track processed messages to prevent duplicates
const processedMessages = new Set();
setInterval(() => processedMessages.clear(), 3600000); // Clear hourly

// Store for scheduled message intervals
const scheduledMessages = new Map();

// Bot readiness state for health checks
let isReady = false;

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Google Calendar client
let calendar;
if (config.aiBot.calendar?.enabled) {
  const auth = new google.auth.GoogleAuth({
    keyFile: config.aiBot.calendar.credentialsPath,
    scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'],
  });
  calendar = google.calendar({ version: 'v3', auth });
}

// ============================================================
// Health Check Server
// ============================================================
const HEALTH_PORT = process.env.HEALTH_PORT || 3000;

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    const status = isReady ? 200 : 503;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: isReady ? 'healthy' : 'starting',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(HEALTH_PORT, () => {
  console.log(`Health check available at http://localhost:${HEALTH_PORT}/health`);
});

// ============================================================
// Calendar Helper Functions
// ============================================================

async function checkAvailability(startTime, endTime) {
  try {
    const calendarId = config.aiBot.calendar.calendarId;

    if (!calendarId) {
      throw new Error('CALENDAR_ID is not defined in .env or config.js');
    }

    const response = await calendar.freebusy.query({
      resource: {
        timeMin: startTime,
        timeMax: endTime,
        items: [{ id: calendarId }],
      },
    });

    const calendarResult = response.data.calendars[calendarId];
    if (!calendarResult) {
      console.error('Calendar API Error: No data returned for ID:', calendarId);
      console.log('Full Response Scope:', JSON.stringify(response.data, null, 2));
      return `Error: Calendar information not found for ${calendarId}`;
    }

    const busy = calendarResult.busy || [];
    if (busy.length > 0) {
      return `Busy during these times: ${JSON.stringify(busy)}`;
    }
    return 'Free';
  } catch (error) {
    console.error('Calendar Error:', error);
    return `Error checking availability: ${error.message}`;
  }
}

async function bookAppointment(serviceId, startTime, guestEmail, customerInfo) {
  try {
    const service = config.services[serviceId];
    if (!service) {
      return `Error: Service '${serviceId}' not found.`;
    }

    const start = new Date(startTime);
    // Duration from config
    const end = new Date(start.getTime() + service.duration * 60000);

    const customerName = customerInfo?.name || 'Customer';
    const customerNumber = customerInfo?.number || 'Unknown';

    const summary = `${service.name} - ${customerName}`;
    const description = `Service: ${service.name}\nCustomer: ${customerName}\nPhone: ${customerNumber}\nDuration: ${service.duration} mins\nPrice: ${service.price} LKR\nBooked via WhatsApp Assistant.`;

    const event = {
      summary: summary,
      description: description,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      attendees: guestEmail ? [{ email: guestEmail }] : [],
    };

    const response = await calendar.events.insert({
      calendarId: config.aiBot.calendar.calendarId,
      resource: event,
    });

    const eventLink = response.data.htmlLink;
    return `Appointment booked for ${service.name}!\nCustomer: ${customerName}\nPrice: ${service.price} LKR\nView Event: ${eventLink}`;
  } catch (error) {
    console.error('Booking Error:', error);
    return `Error booking appointment: ${error.message}`;
  }
}

// ============================================================
// WhatsApp Client Configuration
// ============================================================
const puppeteerConfig = {
  args: config.client.puppeteerArgs
};

// Add executablePath if specified in config
if (config.client.executablePath) {
  puppeteerConfig.executablePath = config.client.executablePath;
}

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: config.client.sessionPath
  }),
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1018939634-alpha.html',
  },
  puppeteer: puppeteerConfig
});

// ============================================================
// Bot Startup & Event Handlers
// ============================================================
console.log(`Starting WhatsApp Bot (PID: ${process.pid})...`);

client.on('qr', (qr) => {
  console.log('\n📱 Scan this QR code with your WhatsApp:');
  qrcode.generate(qr, { small: true });
  console.log('\n⏳ Waiting for QR code scan...\n');
});

// Client is ready
client.on('ready', async () => {
  isReady = true;
  console.log('WhatsApp Bot is ready!');
  console.log('📞 Connected as:', client.info.pushname);
  console.log('📱 Phone:', client.info.wid.user);
  console.log('━'.repeat(50));

  // Safety patch for the 'markedUnread' error
  try {
    await client.pupPage.evaluate(() => {
      if (window.WWebJS && window.WWebJS.sendSeen) {
        const originalSendSeen = window.WWebJS.sendSeen;
        window.WWebJS.sendSeen = async (chatId) => {
          try {
            return await originalSendSeen(chatId);
          } catch (e) {
            return true; // Ignore failures in marking as seen
          }
        };
      }
    });
  } catch (patchError) {
    console.warn('⚠️ Could not apply sendSeen patch (might not be needed):', patchError.message);
  }

  // Start automatic message sending if enabled
  if (config.autoSend.enabled) {
    startAutoSend();
  }

  if (config.autoReply.enabled) {
    console.log('✉️  Auto-reply is enabled');
  }

  console.log('\n💬 Bot is now listening for messages...\n');
});

// Handle authentication
client.on('authenticated', () => {
  console.log('🔐 Authentication successful!');
});

// Handle authentication failure
client.on('auth_failure', (msg) => {
  console.error('❌ Authentication failed:', msg);
});

client.on('disconnected', (reason) => {
  isReady = false;
  console.log('Client disconnected:', reason);
  scheduledMessages.forEach(interval => clearInterval(interval));
  scheduledMessages.clear();
});

// Handle incoming messages
client.on('message', async (message) => {
  // Prevent duplicate processing
  if (processedMessages.has(message.id._serialized)) return;
  processedMessages.add(message.id._serialized);

  try {
    // Get contact and chat info (fetched once, reused throughout)
    const contact = await message.getContact();
    const chat = await message.getChat();
    const customerInfo = {
      name: contact.name || contact.pushname || 'Customer',
      number: message.from.split('@')[0] // Clean number
    };

    // Log message if enabled
    if (config.bot.logMessages) {
      console.log(`📨 Message from ${customerInfo.name} (${message.from}): ${message.body}`);
    }

    // Ignore if auto-reply is disabled
    if (!config.autoReply.enabled) return;

    // Ignore own messages
    if (config.bot.ignoreOwnMessages && message.fromMe) return;

    // Ignore broadcast messages if configured
    if (config.bot.ignoreBroadcast && message.from === 'status@broadcast') return;

    // Group Message Handling
    if (message.from.endsWith('@g.us')) {
      if (config.bot.ignoreGroups) return; // Completely ignore if configured

      // Check if bot is mentioned
      const mentions = await message.getMentions();
      const isMentioned = mentions.some(contact => contact.id._serialized === client.info.wid._serialized);

      // Check if replying to bot
      let isReplyingToBot = false;
      if (message.hasQuotedMsg) {
        const quotedMsg = await message.getQuotedMessage();
        if (quotedMsg.author === client.info.wid._serialized || quotedMsg.fromMe) {
          isReplyingToBot = true;
        }
      }

      // If not mentioned and not replying to bot, ignore group message
      if (!isMentioned && !isReplyingToBot) {
        return;
      }

      console.log('🔔 Bot mentioned or replied to in group. Processing...');
    }

    // Check for keyword matches
    const messageBody = message.body.toLowerCase();
    let replied = false;

    // AI Auto-Reply Logic
    if (config.aiBot && config.aiBot.enabled) {
      try {
        console.log('🤖 AI processing message... (OpenAI)');

        let messages = [];

        // 1. Add System Prompt
        messages.push({ role: "system", content: config.aiBot.systemPrompt });

        // 2. Add Chat History (if enabled)
        if (historyManager) {
          const history = historyManager.getMessages(message.from);
          messages = messages.concat(history);
        }

        // 3. Add Current User Message
        const userMessage = { role: "user", content: message.body };
        messages.push(userMessage);

        // Define tools
        const tools = [
          {
            type: "function",
            function: {
              name: "check_availability",
              description: "Check if the calendar is free for a specific time range.",
              parameters: {
                type: "object",
                properties: {
                  start_time: { type: "string", description: "ISO 8601 start time (e.g. 2024-05-21T10:00:00Z)" },
                  end_time: { type: "string", description: "ISO 8601 end time" },
                },
                required: ["start_time", "end_time"],
              },
            },
          },
          {
            type: "function",
            function: {
              name: "book_appointment",
              description: "Book a salon appointment for a specific service.",
              parameters: {
                type: "object",
                properties: {
                  service_id: {
                    type: "string",
                    enum: Object.keys(config.services),
                    description: "The ID of the service to book (e.g., haircut, beard_trim)"
                  },
                  start_time: { type: "string", description: "ISO 8601 start time" },
                  guest_email: { type: "string", description: "Email of the guest (optional)" },
                },
                required: ["service_id", "start_time"],
              },
            },
          }
        ];

        let loopCount = 0;
        const MAX_LOOPS = 5;
        let finalReplySent = false;

        while (loopCount < MAX_LOOPS && !finalReplySent) {
          loopCount++;

          const response = await openai.chat.completions.create({
            model: config.aiBot.model,
            messages: messages,
            tools: tools,
            tool_choice: "auto",
          }).catch(err => {
            console.error('DEBUG OpenAI API Error:', err);
            throw err;
          });

          const responseMessage = response.choices[0].message;

          if (responseMessage.tool_calls) {
            messages.push(responseMessage);

            for (const toolCall of responseMessage.tool_calls) {
              const fnName = toolCall.function.name;
              const args = JSON.parse(toolCall.function.arguments);
              let toolResult;

              console.log(`🛠️ Executing tool: ${fnName}`);

              if (fnName === 'check_availability') {
                toolResult = await checkAvailability(args.start_time, args.end_time);
              } else if (fnName === 'book_appointment') {
                toolResult = await bookAppointment(args.service_id, args.start_time, args.guest_email, customerInfo);
              } else {
                toolResult = "Unknown tool";
              }

              messages.push({
                tool_call_id: toolCall.id,
                role: "tool",
                name: fnName,
                content: toolResult,
              });
            }
            // Loop continues to process tool results
          } else {
            // No tool calls, final response
            const aiReply = responseMessage.content;
            if (aiReply) {
              try {
                await chat.sendMessage(aiReply);
                console.log('✅ AI replied:', aiReply);
              } catch (sendError) {
                console.error('❌ Error sending AI reply, trying client fallback:', sendError.message);
                await client.sendMessage(message.from, aiReply);
              }
              messages.push({ role: "assistant", content: aiReply });
              replied = true;
            }
            finalReplySent = true;
          }
        }

        // Save interaction to history logic
        if (historyManager) {
          // We need to verify what is new.
          // messages array:
          // 0: System
          // 1..H: Old History
          // H+1: User Message
          // H+2..: New Assistant/Tool Messages

          const historyLen = historyManager.getMessages(message.from).length;
          // We expect User Message to be at index (1 + historyLen), wait.
          // History from manager does NOT include system prompt.
          // So messages array has: [System, ...History, User, ...]
          // Length of History part is historyLen.
          // System is 1.
          // So User starts at 1 + historyLen.

          const newContent = messages.slice(1 + historyLen);

          for (const msg of newContent) {
            historyManager.addMessage(message.from, msg);
          }
        }

        replied = true;
      } catch (aiError) {
        console.error('❌ AI Error:', aiError.message);
        console.log('⚠️ Falling back to keyword/default reply...');
        if (!config.aiBot.fallbackToDefault) return;
      }
    }

    if (!replied) {
      for (const [keyword, response] of Object.entries(config.autoReply.keywords)) {
        if (messageBody.includes(keyword.toLowerCase())) {
          try {
            await chat.sendMessage(response);
            console.log(`✅ Auto-replied with keyword: "${keyword}"`);
          } catch (sendError) {
            console.error('❌ Error sending keyword reply:', sendError.message);
            await client.sendMessage(message.from, response);
          }
          replied = true;
          break;
        }
      }
    }

    // Send default reply if no keyword matched and default reply is enabled
    if (!replied && config.autoReply.useDefaultReply) {
      try {
        await chat.sendMessage(config.autoReply.defaultReply);
        console.log('✅ Auto-replied with default message');
      } catch (sendError) {
        console.error('❌ Error sending default reply:', sendError.message);
        await client.sendMessage(message.from, config.autoReply.defaultReply);
      }
    }

  } catch (error) {
    console.error('❌ Error handling message:', error);
  }
});

// ============================================================
// Utility Functions
// ============================================================

async function sendMessage(to, message) {
  try {
    await client.sendMessage(to, message);
    console.log(`✅ Message sent to ${to}`);
    return true;
  } catch (error) {
    console.error(`❌ Error sending message to ${to}:`, error);
    return false;
  }
}

function startAutoSend() {
  console.log('\n🚀 Starting automatic message sending...');

  config.autoSend.messages.forEach((msgConfig, index) => {
    const { to, message, schedule } = msgConfig;

    // Send immediately if configured
    if (schedule.immediate) {
      setTimeout(() => {
        sendMessage(to, message);
      }, 1000); // Small delay to ensure client is ready
    }

    // Schedule with delay
    if (schedule.delay > 0 || !schedule.immediate) {
      setTimeout(() => {
        sendMessage(to, message);

        // Set up interval if configured
        if (schedule.interval > 0) {
          const intervalId = setInterval(() => {
            sendMessage(to, message);
          }, schedule.interval);

          scheduledMessages.set(`msg_${index}`, intervalId);
          console.log(`⏰ Scheduled message ${index + 1} to repeat every ${schedule.interval}ms`);
        }
      }, schedule.delay);
    }
  });
}

// ============================================================
// Graceful Shutdown
// ============================================================
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  scheduledMessages.forEach(interval => clearInterval(interval));
  scheduledMessages.clear();
  healthServer.close();
  await client.destroy();
  console.log('Bot stopped');
  process.exit(0);
});

// Start the client
client.initialize();
