import { Body, Controller, Get, Headers, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { AttachmentsService } from './attachments.service';
import { AttachmentLimitsService } from './limits.service';
import type { AuthenticatedUser } from '../auth/auth.service';

@UseGuards(JwtAuthGuard)
@Controller()
export class AttachmentsController {
  constructor(
    private readonly svc: AttachmentsService,
    private readonly limits: AttachmentLimitsService,
  ) {}

  /**
   * POST /pr/:id/attachments — upload one file.
   *
   * The body is read as a RAW STREAM, not through the global JSON body parser,
   * for two reasons: the size ceiling must be the CONFIGURED one rather than a
   * framework default, and an oversized body must be refused before it is
   * buffered rather than after.
   *
   * Metadata travels in headers so the bytes need no envelope:
   *   x-file-name    original filename (sanitised server-side)
   *   content-type   MIME type
   *   x-file-kind    'image' to apply the image ceilings, optional
   */
  @Post('pr/:id/attachments')
  async upload(
    @Param('id') id: string,
    @Req() req: any,
    @Headers('x-file-name') fileName: string,
    @Headers('content-type') contentType: string,
    @Headers('x-file-kind') fileKind: string | undefined,
  ) {
    const u = req.user as AuthenticatedUser;
    if (!fileName) {
      // Reject before reading the body so a headerless upload costs nothing.
      req.resume?.();
      return { statusCode: 400, message: 'x-file-name is required', error: 'Bad Request' };
    }
    return this.svc.uploadToPr(
      id, u.id, u.role, u.costCenterIds, req, fileName, contentType, fileKind,
    );
  }

  /** GET /pr/:id/attachments — the live set plus its version history. */
  @Get('pr/:id/attachments')
  async list(@Param('id') id: string, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.listForPr(id, u.id, u.role, u.costCenterIds);
  }

  /**
   * GET /attachments/limits — what the ceilings currently are and where each came
   * from, so an admin can tell "configured at 25 MiB" from "nobody configured it".
   */
  @Get('attachments/limits')
  async limitsReport() {
    return this.svc.limitsReport();
  }

  /**
   * POST /attachments/limits/sync — re-apply the environment overrides without a
   * restart. Handy after changing a variable in a live environment.
   */
  @Post('attachments/limits/sync')
  async sync(@Req() req: any) {
    const u = req.user as AuthenticatedUser;
    if (!['admin', 'procurement', 'cs'].includes(u.role)) {
      return { statusCode: 403, message: 'Only admin, procurement or CS may re-sync limits.', error: 'Forbidden' };
    }
    const applied = await this.limits.syncFromEnv();
    return { applied, current: await this.svc.limitsReport() };
  }

  /** POST /attachments/:id/void — retire a record; there is no hard delete. */
  @Post('attachments/:id/void')
  async voidIt(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    const u = req.user as AuthenticatedUser;
    return this.svc.voidAttachment(id, u.id, u.role, u.costCenterIds, body?.reason);
  }

  /**
   * GET /attachments/:id/download — stream one file back.
   *
   * The filename is echoed in Content-Disposition with quotes stripped, so a
   * crafted name cannot inject a header. RFC 5987's `filename*` carries the
   * original for non-ASCII names.
   */
  @Get('attachments/:id/download')
  async download(@Param('id') id: string, @Req() req: any, @Res() res: any) {
    const u = req.user as AuthenticatedUser;
    const file = await this.svc.download(id, u.id, u.role, u.costCenterIds);
    const safeName = file.name.replace(/["\\]/g, '_');
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    // An attachment is a document, never something a browser may execute.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    file.stream.pipe(res);
  }
}
