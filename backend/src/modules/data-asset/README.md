# Data Asset (SOP-8, P3)

Minimal original-data-asset tracker. A data asset earns AI citations/links when
it is named after the client brand (or unambiguously subject-matter), documents
its methodology (claims discipline applies to published numbers), and publishes
numbers other pages can cite. Deliberately NOT a survey runner — lifecycle only.

## Files

```
data-asset/
├── data-asset.service.ts     # create / list / update / delete
├── data-asset.controller.ts  # 4 routes under /projects/:id/data-asset
├── dto/data-asset.dto.ts
├── data-asset.module.ts
└── README.md
```

## Model

`DataAsset(projectId, title, brandAlignment: brand-named|subject-matter,
methodologyNote, surveySize?, assetUrl?, status: planned|fielding|published,
publishedAt?)`

- `PATCH` with `status:"published"` stamps `publishedAt`.
- Invalid lifecycle/alignment values → 400; cross-project ids → 404.

## e2e evidence (2026-08-30, :3111)

1. Create (`brand-named`, n=512, methodology note) → 201.
2. `{"status":"published","assetUrl":"…"}` → 200, `publishedAt` stamped, URL persisted.
3. `status:"nope"` → **400** (and during e2e the PATCH DTO was fixed — it had inherited a required `title` from the create DTO, breaking partial updates).

Test rows wiped; server killed.

## PRD alignment

| PRD ref | Implementation |
|---|---|
| SOP-8 original data asset | lifecycle tracker with brand-alignment guidance |
| FR-9.4 (claims discipline) | methodologyNote field documented as required for sourceable numbers |