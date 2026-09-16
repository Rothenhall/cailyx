/**
 * Regenerates `backend/openapi.json` from the running application.
 *
 * Why this exists: the checked-in spec had drifted to 261 operations while the
 * application served 535. Appendix B's D01 asks for the docs to be regenerated,
 * and the only way to keep that from happening again is to make regeneration a
 * command rather than a manual export.
 *
 * It runs against the **compiled** output in `dist/`, so it needs no TypeScript
 * runner — this repo has none installed and adding one is a dependency
 * decision, not a script decision. Run `npm run openapi`, which builds first.
 *
 * It boots the Nest application in-process with `app.init()` — not `listen()` —
 * so it needs no port and does not collide with a dev server already running.
 * `init()` alone starts no scheduler and opens no Redis connection.
 */

const { NestFactory } = require('@nestjs/core');
const { DocumentBuilder, SwaggerModule } = require('@nestjs/swagger');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const { AppModule } = require('../dist/app.module');

async function main() {
  // Mirrors main.ts's own options so the document matches what the app serves;
  // a spec generated from a differently-configured instance is the same class
  // of drift this script exists to prevent.
  const app = await NestFactory.create(AppModule, { rawBody: true, logger: false });
  app.setGlobalPrefix('api');

  const config = new DocumentBuilder()
    .setTitle('Cailyx API')
    .setDescription('Cailyx backend API documentation')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);

  const outPath = join(__dirname, '..', 'openapi.json');
  writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const operations = Object.values(document.paths).reduce(
    (total, methods) =>
      total +
      Object.keys(methods).filter((method) =>
        ['get', 'post', 'put', 'patch', 'delete'].includes(method),
      ).length,
    0,
  );

  console.log(
    `Wrote ${outPath}\n  paths: ${Object.keys(document.paths).length}\n  operations: ${operations}`,
  );

  await app.close();
}

main().catch((error) => {
  console.error('Failed to generate the OpenAPI document:', error);
  process.exit(1);
});
