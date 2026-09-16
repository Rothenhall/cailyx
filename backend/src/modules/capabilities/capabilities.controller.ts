/**
 * CapabilitiesController — G18's HTTP surface.
 *
 * Three route groups in one file, because the difference between them is
 * *audience*, and that difference is the package's point:
 *
 *   Operator  /api/capabilities                       — the whole readiness roster
 *   Operator  /api/projects/:projectId/capabilities   — plus project resource and scheduler state
 *   Client    /api/portal/projects/:projectId/capabilities — a reduced, separately-built DTO
 *
 * The client route is a separate controller class so `@ClientPortal()` marks
 * the whole surface at once — RolesGuard is default-deny for client users, and
 * a client route that quietly inherited the operator guard would be a hole.
 *
 * Every handler validates project ownership against the URL's `:projectId`
 * before it reads anything (AGENT-BRIEF rule 1). The operator routes carry
 * env var names and raw provider errors; the client route carries neither,
 * and that is enforced by the response shape rather than by filtering.
 *
 * @module capabilities.controller
 */

import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClientPortal } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ScopeValidationService } from '../../common/guards/scope-validation.service';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { CapabilitiesService, type CapabilityCaller } from './capabilities.service';

/** Maps the JWT payload onto the service's caller shape. */
function callerOf(user: AuthedRequestUser): CapabilityCaller {
  return { userId: user.userId, role: user.role, type: user.type, clientId: user.clientId };
}

// ── Operator roster ─────────────────────────────────────────────────────

@ApiTags('capabilities')
@ApiBearerAuth()
@Controller('capabilities')
export class CapabilitiesController {
  constructor(private readonly capabilities: CapabilitiesService) {}

  /**
   * Every capability, with the four readiness facts kept separate and the
   * derived state alongside them.
   *
   * Readable by any operator role: knowing what can actually run is a
   * precondition for doing the work, not an administrative privilege.
   */
  @Get()
  @ApiOperation({
    summary: 'Readiness of every provider-backed capability',
    description:
      'Each entry reports four independent facts — server config present, credential actually proven by a recorded ' +
      'successful call, caller authorized, project resource mapped — plus the derived state, `stateDetail` (why it ' +
      'is in that state) and `operatorGuidance` (the configuration fact an operator needs, carried in every state). ' +
      '`allowedActions` is empty unless the state is "ready", so no action is offered merely because an env key ' +
      'exists. Fixture mode is disclosed on every entry it could affect.',
  })
  @ApiResponse({
    status: 200,
    description:
      '{ capabilities: CapabilityView[], summary: { total, ready, byState, mockModeKeys }, audience: "operator" }',
  })
  async list(@CurrentUser() user: AuthedRequestUser) {
    return this.capabilities.list(callerOf(user));
  }
}

// ── Project readiness ───────────────────────────────────────────────────

@ApiTags('capabilities: project')
@ApiBearerAuth()
@Controller('projects/:projectId/capabilities')
export class ProjectCapabilitiesController {
  constructor(
    private readonly capabilities: CapabilitiesService,
    private readonly scope: ScopeValidationService,
  ) {}

  /**
   * The same roster, narrowed to what this project can actually do.
   *
   * Adds the two project-scoped facts: whether the project has the resource a
   * capability needs (`resourceMapped`), and the scheduler state for the task
   * kinds it serves. The acceptance criterion for this route is the pairing
   * of "OAuth connected" with "resource unmapped" — a connected Google
   * account that has not been pointed at a property is `unmapped`, not ready.
   */
  @Get()
  @ApiOperation({
    summary: "A project's capability readiness, with mapped resources and scheduler state",
    description:
      'OAuth connected but no site/property chosen for this project is reported as "unmapped" with the action to ' +
      'take, not as an error. A missing browser session is reported as "unconfigured" naming the exact step. ' +
      'A provider whose last call failed is "degraded" and offers no actions.',
  })
  @ApiResponse({ status: 200, description: '{ projectId, project, capabilities, summary, audience }' })
  @ApiResponse({ status: 403, description: 'Caller is not assigned to this project' })
  @ApiResponse({ status: 404, description: 'Project does not exist' })
  async list(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.capabilities.listForProject(callerOf(user), projectId);
  }
}

// ── Client view ─────────────────────────────────────────────────────────

/**
 * The client's own readiness view.
 *
 * `@ClientPortal()` marks the whole class and `clientId` comes from the JWT,
 * never from a request field, so a client cannot ask for another client's
 * project by editing the URL. The response is a **separate, reduced shape**
 * built by the service — it has no field for an env var name, a provider key,
 * an internal error string or a blocked-by code, so there is nothing to
 * filter at the edge and nothing to forget to filter.
 */
@ApiTags('capabilities: portal')
@ApiBearerAuth()
@ClientPortal()
@Controller('portal/projects/:projectId/capabilities')
export class PortalCapabilitiesController {
  constructor(
    private readonly capabilities: CapabilitiesService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'What Cailyx can measure for this project, in client terms',
    description:
      'Only capabilities that produce something a client sees. Each entry says whether it is available, what the ' +
      'client can do if anything, how current the data is, and whether it came from the live provider or from ' +
      'fixtures — never an internal key, secret name or infrastructure diagnostic.',
  })
  @ApiResponse({ status: 200, description: '{ projectId, audience: "client", capabilities, summary, note }' })
  @ApiResponse({ status: 404, description: 'Project does not belong to this client' })
  async list(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.capabilities.listForClient(callerOf(user), projectId);
  }
}
