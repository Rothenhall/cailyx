# Projects Module — API Reference

## POST /api/projects
Create a project.

**Body:**
```json
{
  "name": "Rothenhall Partners",
  "domain": "rothenhall.com",
  "category": "AI Visibility Consultancy",
  "clientName": "Rothenhall Ltd",
  "notes": "Pilot engagement
  "notes": "Pilot engagement — full diagnostic"
}
```

**201 Response:**
```json
{
  "id": "cmtesx12500008dmx9hpemq0r",
  "name": "Rothenhall Partners",
  "domain": "rothenhall.com",
  "category": "AI Visibility Consultancy",
  "clientName": "Rothenhall Ltd",
  "status": "diagnostic",
  "notes": "Pilot engagement — full diagnostic",
  "createdAt": "2026-08-30T00:00:00.000Z",
  "updatedAt": "2026-08-30T00:00:00.000Z"
}
```

**409** if a project for this domain already exists.

## GET /api/projects?status=diagnostic&search=rothenhall
Filter by status, search across name/domain/clientName.

## GET /api/projects/:id
Project detail with stats:
```json
{
  "id": "...", "name": "...", "domain": "...", "status": "...",
  "stats": { "technicalAudits": 0, "reports": 0, "entities": 0, "gaps": 0, "scheduleActive": false }
}
```

## PATCH /api/projects/:id
Update name, category, clientName, notes, or status.

## PUT /api/projects/:id/transition
**Body:** `{ "status": "sprint" }`

Legal transitions per PLAN Phase 0:
- scorecard → diagnostic
- diagnostic → sprint
- sprint → retainer | diagnostic (restart)
- any → archived
- archived → diagnostic (reactivate)

Invalid transition → 409.

## DELETE /api/projects/:id
Delete project. 204 on success.