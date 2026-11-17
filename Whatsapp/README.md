# WhatsApp APEX API Server

A secure WhatsApp messaging server with **anti-ban protection**, designed for Oracle APEX integration.

## Features

- 🔐 **API Key Authentication** - Secure REST API
- 🛡️ **Anti-Ban Protection:**
  - Typing simulation (shows "typing..." before sending)
  - Gaussian random delays (human-like timing)
  - Rate limiting (max messages per hour)
  - Spintax message variation (each message slightly different)
- 📱 **QR Code Auth** - Scan once, stays connected
- 📋 **Message History** - Track all sent messages
- 🔄 **Auto-reconnect** - Recovers from disconnections
- 📊 **Status Dashboard** - Monitor everything via API

## Quick Start

### 1. Install
```bash
npm install
```

### 2. Configure
Edit `.env` file:
```
API_KEY=your-secret-key-here
MAX_MESSAGES_PER_HOUR=15
```

### 3. Run
```bash
npm start
```

### 4. Scan QR Code
A QR code will appear in the terminal. Scan it with your WhatsApp phone app.

### 5. Send Messages
```bash
curl -X POST http://localhost:3000/api/send-message \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-key-here" \
  -d '{"phone": "923001234567", "message": "Hello from APEX!"}'
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/send-message` | Send a WhatsApp message |
| POST | `/api/send-receipt` | Send a formatted order receipt |
| GET  | `/api/status` | Check connection & rate limits |
| GET  | `/api/history` | View sent message history |
| GET  | `/api/health` | Simple health check |

## Oracle APEX Integration

```sql
DECLARE
    l_body     CLOB;
    l_response CLOB;
BEGIN
    l_body := '{"phone": "' || :P10_PHONE || '", "message": "Order #' || :P10_ORDER_ID || ' confirmed!"}';

    apex_web_service.g_request_headers.DELETE;
    apex_web_service.g_request_headers(1).name  := 'Content-Type';
    apex_web_service.g_request_headers(1).value := 'application/json';
    apex_web_service.g_request_headers(2).name  := 'x-api-key';
    apex_web_service.g_request_headers(2).value := 'your-secret-key-here';

    l_response := apex_web_service.make_rest_request(
        p_url         => 'http://localhost:3000/api/send-message',
        p_http_method => 'POST',
        p_body        => l_body
    );
END;
```

## Anti-Ban Settings (.env)

| Setting | Default | Description |
|---------|---------|-------------|
| `MAX_MESSAGES_PER_HOUR` | 15 | Maximum messages allowed per hour |
| `MIN_DELAY_MS` | 10000 | Minimum delay between messages (ms) |
| `MAX_DELAY_MS` | 30000 | Maximum delay between messages (ms) |
| `ENABLE_TYPING` | true | Show "typing..." before sending |
| `ENABLE_SPINTAX` | true | Vary message text automatically |

## Project Structure

```
whatsapp/
├── .env                 # Configuration (secrets)
├── .env.example         # Configuration template
├── package.json
├── README.md
├── src/
│   ├── index.js         # Main entry point
│   ├── whatsapp.js      # WhatsApp client manager
│   ├── routes.js        # REST API endpoints
│   ├── antiban.js       # Anti-ban protection layer
│   ├── history.js       # Message history store
│   └── logger.js        # Logging (Winston)
└── logs/                # Log files (auto-created)
```
