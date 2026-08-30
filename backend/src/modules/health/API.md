# Health Module — API Reference

## Endpoints

### GET /api/health

Check if the API server is running.

**Authentication:** None
**Rate limit:** 100 requests per 60s (global default)

**Response — 200 OK:**
```json
{
  "status": "ok",
  "timestamp": "2026-08-28T13:40:07.000Z",
  "uptime": 4.749
}
```

**Error Responses:**
- `503 Service Unavailable` — server is shutting down or unhealthy