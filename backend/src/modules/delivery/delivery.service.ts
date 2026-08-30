/**
 * Delivery Service — PRD §6.11: transactional email (Plunk), Lead CRM with
 * CTA logging, and the Stripe Checkout upgrade ledger.
 *
 * Guards are honest (same posture as findings/page-analysis):
 *  - Email without PLUNK_API_KEY → 503 `email-unconfigured`, nothing sent.
 *  - Upgrades without the tier's STRIPE_CHECKOUT_URL_* → 503
 *    `payment-unconfigured`, nothing persisted.
 *
 * @module delivery.service
 */

import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { CreateLeadDto, LogCtaDto, SendReportDto, UpdateLeadDto } from './dto/delivery.dto';
import { CreateUpgradeDto } from './dto/upgrade.dto';
import {
  CHECKOUT_URL_ENV,
  CtaEvent,
  CtaEventType,
  DeliveryEmailResult,
  UpgradeStatus,
  UpgradeTier,
  UpgradeView,
} from './delivery.types';

interface LeadRow {
  id: string;
  projectId: string;
  email: string;
  name?: string | null;
  source: string;
  status: string;
  scorecardRunId?: string | null;
  ctaEvents: string;
  createdAt: Date;
}

interface UpgradeRow {
  id: string;
  projectId: string;
  leadId?: string | null;
  tier: string;
  status: string;
  checkoutUrl?: string | null;
  stripeSessionId?: string | null;
  createdAt: Date;
  completedAt?: Date | null;
}

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // ─── FR-11.1 Delivery email (Plunk) ─────────────────────────────────

  /**
   * Send the report-link email through Plunk. Link-first: the PDF surface is
   * a URL (react-pdf rendering is frontend scope); the template is editable
   * via the subject override before send (operator mode, FR-11.1).
   */
  async sendReport(projectId: string, dto: SendReportDto): Promise<DeliveryEmailResult> {
    await this.assertProject(projectId);
    const apiKey = this.config.get<string>('PLUNK_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'email-unconfigured: PLUNK_API_KEY is not set — nothing was sent',
      );
    }
    const body = this.renderEmail(dto);
    try {
      const res = await fetch('https://api.useplunk.com/v1/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ to: dto.to, subject: body.subject, body: body.html }),
      });
      if (!res.ok) {
        const detail = await res.text();
        this.logger.error(`Plunk send failed (${res.status}): ${detail.slice(0, 300)}`);
        throw new ServiceUnavailableException(`email-send-failed: Plunk returned ${res.status}`);
      }
      const json = (await res.json().catch(() => ({}))) as { message_id?: string };
      this.logger.log(`Report delivered to ${dto.to} for project ${projectId}`);
      return { delivered: true, messageId: json.message_id, to: dto.to, reportUrl: dto.reportUrl };
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      throw new ServiceUnavailableException(`email-send-failed: ${(err as Error).message}`);
    }
  }

  /** Templated, sourceable email body — the CTA contract of FR-11.3. */
  private renderEmail(dto: SendReportDto): { subject: string; html: string } {
    const subject = dto.subject ?? 'Your AI visibility report';
    const cta = `<p><a href="${dto.reportUrl}">Open your full report</a> — and book a walkthrough if anything raises questions.</p>`;
    const testimonial = dto.includeTestimonialAsk
      ? '<p>If the findings were useful, a one-line review would genuinely help us.</p>'
      : '';
    return { subject, html: `${cta}${testimonial}` };
  }

  // ─── FR-11.2 Lead CRM ────────────────────────────────────────────────

  async createLead(projectId: string, dto: CreateLeadDto) {
    await this.assertProject(projectId);
    const lead = await this.prisma.lead.create({
      data: {
        projectId,
        email: dto.email,
        name: dto.name,
        source: dto.source ?? 'form',
        scorecardRunId: dto.scorecardRunId,
      },
    });
    return this.leadView(lead);
  }

  async listLeads(projectId: string, status?: string) {
    const leads = await this.prisma.lead.findMany({
      where: { projectId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    return leads.map((l) => this.leadView(l));
  }

  /** One lead (ownership-checked) with its parsed CTA event log. */
  async getLead(projectId: string, leadId: string) {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, projectId } });
    if (!lead) throw new NotFoundException('Lead not found in this project: ' + leadId);
    return this.leadView(lead);
  }

  async updateLead(projectId: string, leadId: string, dto: UpdateLeadDto) {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, projectId } });
    if (!lead) throw new NotFoundException('Lead not found in this project: ' + leadId);
    const updated = await this.prisma.lead.update({
      where: { id: leadId },
      data: { status: dto.status, name: dto.name },
    });
    return this.leadView(updated);
  }

  /** Log a CTA click against a lead (FR-11.3) — appended, never overwritten. */
  async logCta(projectId: string, leadId: string, dto: LogCtaDto): Promise<CtaEvent[]> {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, projectId } });
    if (!lead) throw new NotFoundException('Lead not found in this project: ' + leadId);
    const events: CtaEvent[] = JSON.parse(lead.ctaEvents);
    const event: CtaEvent = { type: dto.type as CtaEventType, at: new Date().toISOString(), meta: dto.meta };
    events.push(event);
    await this.prisma.lead.update({ where: { id: leadId }, data: { ctaEvents: JSON.stringify(events) } });
    return events;
  }

  /** CSV export for whichever external CRM the operator uses (Attio/HubSpot later). */
  async exportLeadsCsv(projectId: string): Promise<string> {
    const leads = await this.prisma.lead.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    const rows = leads.map((l) => {
      const events: CtaEvent[] = JSON.parse(l.ctaEvents);
      const ctaCounts = events.map((e) => e.type).join('|');
      return [l.email, l.name ?? '', l.source, l.status, ctaCounts, l.createdAt.toISOString()]
        .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
        .join(',');
    });
    return ['email,name,source,status,ctaEvents,createdAt', ...rows].join('\n');
  }

  private leadView(lead: LeadRow) {
    return { ...lead, ctaEvents: JSON.parse(lead.ctaEvents) as CtaEvent[] };
  }

  // ─── FR-11.4 Stripe Checkout upgrades ────────────────────────────────

  /**
   * Issue a Checkout link for the tier. The pricing page URL is env-configured
   * (option A); without it the endpoint is an honest 503 and nothing is
   * recorded — a funnel step that cannot proceed should not be persisted.
   */
  async createUpgrade(projectId: string, dto: CreateUpgradeDto): Promise<UpgradeView> {
    await this.assertProject(projectId);
    if (dto.leadId) {
      const lead = await this.prisma.lead.findFirst({ where: { id: dto.leadId, projectId } });
      if (!lead) throw new NotFoundException('Lead not found in this project: ' + dto.leadId);
    }
    const envKey = CHECKOUT_URL_ENV[dto.tier as UpgradeTier];
    const checkoutUrl = this.config.get<string>(envKey);
    if (!checkoutUrl) {
      throw new ServiceUnavailableException(
        `payment-unconfigured: ${envKey} is not set — no checkout link to issue`,
      );
    }
    const upgrade = await this.prisma.upgrade.create({
      data: { projectId, leadId: dto.leadId, tier: dto.tier, status: 'created', checkoutUrl },
    });
    return this.upgradeView(upgrade);
  }

  /** Log the checkout click: flips the ledger row and the lead's event log. */
  async markClicked(projectId: string, upgradeId: string): Promise<UpgradeView> {
    const upgrade = await this.prisma.upgrade.findFirst({ where: { id: upgradeId, projectId } });
    if (!upgrade) throw new NotFoundException('Upgrade not found in this project: ' + upgradeId);
    const updated = await this.prisma.upgrade.update({ where: { id: upgradeId }, data: { status: 'clicked' } });
    if (upgrade.leadId) {
      const lead = await this.prisma.lead.findUnique({ where: { id: upgrade.leadId } });
      if (lead) {
        const events: CtaEvent[] = JSON.parse(lead.ctaEvents);
        events.push({ type: 'upgrade-click', at: new Date().toISOString(), meta: { tier: upgrade.tier } });
        await this.prisma.lead.update({ where: { id: lead.id }, data: { ctaEvents: JSON.stringify(events) } });
      }
    }
    return this.upgradeView(updated);
  }

  /**
   * Completion hook — the Stripe webhook stand-in. Real Stripe SDK integration
   * is the documented next iteration (option A → B without schema churn);
   * signature verification is listed in the module README's left-out section.
   */
  async markCompleted(projectId: string, upgradeId: string, stripeSessionId?: string): Promise<UpgradeView> {
    const upgrade = await this.prisma.upgrade.findFirst({ where: { id: upgradeId, projectId } });
    if (!upgrade) throw new NotFoundException('Upgrade not found in this project: ' + upgradeId);
    const updated = await this.prisma.upgrade.update({
      where: { id: upgradeId },
      data: { status: 'completed' as UpgradeStatus, stripeSessionId, completedAt: new Date() },
    });
    return this.upgradeView(updated);
  }

  async listUpgrades(projectId: string): Promise<UpgradeView[]> {
    const rows = await this.prisma.upgrade.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((u) => this.upgradeView(u));
  }

  private upgradeView(row: UpgradeRow) {
    return this.pick(row);
  }

  /** Column presentation (dates → ISO). */
  private pick(row: UpgradeRow) {
    return {
      id: row.id,
      projectId: row.projectId,
      leadId: row.leadId,
      tier: row.tier,
      status: row.status,
      checkoutUrl: row.checkoutUrl,
      stripeSessionId: row.stripeSessionId,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    };
  }

  private async assertProject(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
  }
}