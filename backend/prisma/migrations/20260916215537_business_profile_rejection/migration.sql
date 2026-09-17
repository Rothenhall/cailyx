-- CreateTable
CREATE TABLE "BusinessProfileRejection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "fieldPath" TEXT NOT NULL,
    "valueHash" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "BusinessProfileRejection_projectId_idx" ON "BusinessProfileRejection"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProfileRejection_projectId_fieldPath_valueHash_key" ON "BusinessProfileRejection"("projectId", "fieldPath", "valueHash");
