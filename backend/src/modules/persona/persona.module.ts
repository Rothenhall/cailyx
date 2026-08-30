/**
 * Persona Module — synthetic buyer persona generator (Agent #1, Swarm layer).
 *
 * Deterministic persona builder (+ optional constrained LLM refinement) that
 * seeds the branching search journeys the `journey` module runs. Personas are
 * research identities only — never used to generate real traffic, clicks, or
 * impressions on any live surface.
 *
 * Depends on: DatabaseModule (PrismaService), ConfigModule (global).
 * Consumed by: journey, council (planned).
 *
 * @module persona.module
 */

import { Module } from '@nestjs/common';
import { PersonaService } from './persona.service';
import { PersonaController } from './persona.controller';

@Module({
  controllers: [PersonaController],
  providers: [PersonaService],
  exports: [PersonaService],
})
export class PersonaModule {}
