# WhatsApp Bot

AI-powered WhatsApp bot with appointment booking via Google Calendar.

## Features

- AI auto-reply using OpenAI GPT
- Google Calendar integration for booking appointments
- Keyword-based auto-replies
- Scheduled message sending
- Health check endpoint
- Docker support

## Quick Start (Docker)

```bash
# Clone and setup
git clone <repository-url>
cd whstspbot
cp .env.example .env

# Add your API keys to .env
# Add google_calendar_credentials.json

# Run
docker compose up -d

# View logs to scan QR code
docker compose logs -f
```

## Quick Start (Local)

```bash
npm install
cp .env.example .env
# Add your API keys to .env
npm start
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `CALENDAR_ID` | Yes | Google Calendar ID (usually your email) |
| `HEALTH_PORT` | No | Health check port (default: 3000) |

### Google Calendar Setup

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable **Google Calendar API**
3. Create a **Service Account** and download JSON key
4. Rename key to `google_calendar_credentials.json` and place in project root
5. Share your calendar with the service account email (found in the JSON file)

### config.js

Edit `config.js` to customize:

- `services` - Available services with name, duration, and price
- `autoReply.keywords` - Keyword-response pairs
- `aiBot.systemPrompt` - AI personality and instructions
- `bot.ignoreGroups` - Whether to respond in groups

## Health Check

```bash
curl http://localhost:3000/health
```

Returns:

```json
{
  "status": "healthy",
  "uptime": 123.45,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Project Structure

```
whstspbot/
├── index.js          # Main application
├── config.js         # Configuration
├── history.js        # Chat history manager
├── start.js          # Startup script with checks
├── Dockerfile        # Docker image
├── docker-compose.yml
└── .env.example
```

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start with pre-flight checks |
| `npm run direct` | Start directly |
| `npm run dev` | Development with auto-reload |
| `docker compose up -d` | Run in Docker |
| `docker compose logs -f` | View logs |

## Troubleshooting

**QR code not showing**: Clear `.wwebjs_auth` folder and restart

**Session expired**: Delete `.wwebjs_auth` and scan QR again

**Calendar not working**: Check service account has calendar access

## License

MIT

## Disclaimer

This bot is for educational and personal use. Make sure to comply with WhatsApp's Terms of Service. The developers are not responsible for any misuse of this software.
