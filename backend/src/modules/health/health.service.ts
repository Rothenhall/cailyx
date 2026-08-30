/**
 * Health service.
 * Contains business logic for health-check operations.
 *
 * @module HealthService
 */

import { Injectable } from '@nestjs/common';

@Injectable()
export class HealthService {
  /**
   * Returns the current health status of the application.
   * @returns An object containing the health status and timestamp
   */
  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }
}
