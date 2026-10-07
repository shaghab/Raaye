import { Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { APP_CONFIG, InboxService, Public, getLogger, lookupSecret, parseMetaWebhook, verifyWebhookSignature, type AppConfig } from '@raaye/server';
import type { Request, Response } from 'express';

/**
 * Public Meta webhook ingress. The app key in the URL selects configuration only; the
 * HMAC over the raw body is the security control. Nothing is written for bad signatures.
 */
@ApiTags('webhooks')
@Controller('webhooks/whatsapp')
export class WebhooksController {
  private readonly logger = getLogger('webhook');

  constructor(
    private readonly inbox: InboxService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get(':appKey')
  async verify(@Param('appKey') appKey: string, @Query('hub.mode') mode: string | undefined, @Query('hub.verify_token') token: string | undefined, @Query('hub.challenge') challenge: string | undefined, @Res() res: Response): Promise<void> {
    const connection = await this.inbox.connectionForAppKey(appKey);
    // A bound reference that does not resolve fails closed; the process-wide token applies only when none is bound.
    const expected = lookupSecret(connection?.verifyTokenRef, this.config.META_WEBHOOK_VERIFY_TOKEN);
    if (expected.source === 'unresolved') this.logger.warn({ appKey, field: 'verifyTokenRef' }, 'Webhook verify token reference does not resolve; refusing verification');
    if (!connection || mode !== 'subscribe' || !expected.value || !token || token !== expected.value || !challenge) {
      res.status(403).type('text/plain').send('Forbidden');
      return;
    }
    res.status(200).type('text/plain').send(challenge);
  }

  @Public()
  @Post(':appKey')
  @HttpCode(200)
  async receive(@Param('appKey') appKey: string, @Headers('x-hub-signature-256') signature: string | undefined, @Req() req: Request & { rawBody?: Buffer }, @Res() res: Response): Promise<void> {
    const connection = await this.inbox.connectionForAppKey(appKey);
    const secret = lookupSecret(connection?.appSecretRef, this.config.META_APP_SECRET);
    if (secret.source === 'unresolved') this.logger.warn({ appKey, field: 'appSecretRef' }, 'Webhook app secret reference does not resolve; refusing delivery');
    const raw = req.rawBody;
    if (!connection || !secret.value || !raw || !verifyWebhookSignature(raw, signature, secret.value)) {
      this.logger.warn({ appKey, hasSignature: Boolean(signature) }, 'Webhook signature rejected');
      res.status(401).json({ code: 'UNAUTHENTICATED', message: 'Invalid signature' });
      return;
    }
    const parsed = parseMetaWebhook(req.body);
    if ('error' in parsed) {
      await this.inbox.quarantine(appKey, 'UNRECOGNIZED_PAYLOAD', null, { note: parsed.error }, new Date());
      res.status(200).json({ received: true, accepted: 0, quarantined: 1 });
      return;
    }
    const result = await this.inbox.ingest(parsed.inbound, parsed.statuses, { appKey, rawPayload: req.body, connectionOverride: connection });
    res.status(200).json({ received: true, ...result, unsupported: parsed.unsupported });
  }
}
