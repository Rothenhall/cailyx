/**
 * Application entry point.
 * Bootstraps the NestJS application, configures Swagger/OpenAPI documentation,
 * global validation pipes, and starts listening on the configured port.
 *
 * @module main
 */

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  // `rawBody` preserves the exact bytes of every request, which the Stripe
  // webhook needs: an HMAC is computed over the transmitted bytes, so verifying
  // against a re-serialized JSON body would be a chance to disagree with what
  // the provider actually signed. It costs one buffer per request that opts in,
  // and nothing else changes.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Global prefix for all API routes
  app.setGlobalPrefix('api');

  // Enable CORS for the frontend(s) — the operator console (3000) and the
  // client-portal app (3001). CORS_ORIGIN can override with a comma-separated list.
  const defaultOrigins = ['http://localhost:3000', 'http://localhost:3001'];
  app.enableCors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()) : defaultOrigins,
    credentials: true,
  });

  // Global validation pipe for DTO validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Swagger / OpenAPI documentation setup
  const config = new DocumentBuilder()
    .setTitle('Cailyx API')
    .setDescription('Cailyx backend API documentation')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
  console.log(`API documentation available at: http://localhost:${port}/api/docs`);
}

bootstrap();
