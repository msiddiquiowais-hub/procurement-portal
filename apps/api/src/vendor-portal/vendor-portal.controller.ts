import {
  BadRequestException, Body, Controller, Get, Headers, Param, Post, Req, Res, UseGuards,
} from '@nestjs/common';
import { VendorPortalService } from './vendor-portal.service';
import type { AuthenticatedUser } from '../auth/auth.service';

/**
 * The vendor's own surface. Deliberately NOT guarded by JwtAuthGuard.
 *
 * That omission is the feature: the whole point of the dispatch link is that a
 * vendor needs no account, no password and no NTN. Putting the JWT guard on these
 * routes would put the login wall straight back that the link exists to remove,
 * and it would break the suppliers — onboarding applications, small firms — who
 * were the reason the token was minted.
 *
 * Because there is no session, the TOKEN IS THE ENTIRE AUTHZ DECISION. The
 * service resolves it by SHA-256, enforces its expiry, and scopes every query to
 * the one vendor and the one RFQ it identifies. There is no route here that takes
 * a vendor id from the client, because a client-supplied vendor id on an
 * unauthenticated route is an IDOR with extra steps.
 */
@Controller('vendor-portal')
export class VendorPortalController {
  constructor(private readonly svc: VendorPortalService) {}

  /** GET /vendor-portal/:token — the assigned pack. */
  @Get(':token')
  async pack(@Param('token') token: string) {
    return this.svc.pack(token);
  }

  /** GET /vendor-portal/:token/template.xlsx — the generated template. */
  @Get(':token/template.xlsx')
  async template(@Param('token') token: string, @Res() res: any) {
    const { buffer, filename } = await this.svc.template(token);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(buffer);
  }

  /** POST /vendor-portal/:token/quote — submit from the form. */
  @Post(':token/quote')
  async quote(@Param('token') token: string, @Body() body: any) {
    return this.svc.submit(token, body);
  }

  /**
   * POST /vendor-portal/:token/upload — re-upload the filled workbook.
   *
   * Raw body, like the attachment upload path, so the file is never base64'd
   * through a JSON envelope and the configured ceiling applies to the real bytes.
   */
  @Post(':token/upload')
  async upload(
    @Param('token') token: string,
    @Req() req: any,
    @Headers('x-file-name') fileName: string,
    @Headers('content-type') contentType: string,
  ) {
    const u = req.user as AuthenticatedUser | undefined;
    if (!fileName) {
      req.resume?.();
      return { statusCode: 400, message: 'x-file-name is required', error: 'Bad Request' };
    }
    const chunks: Buffer[] = [];
    let total = 0;
    // 8 MiB is generous for a quotation workbook and bounded, so a token holder
    // cannot stream the disk through this endpoint. A quotation template is
    // kilobytes; anything approaching this limit is not a spreadsheet.
    const MAX = 8 * 1024 * 1024;
    for await (const chunk of req) {
      const b: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += b.length;
      if (total > MAX) {
        throw new BadRequestException(`That file is larger than the ${MAX} byte upload ceiling.`);
      }
      chunks.push(b);
    }
    if (total === 0) throw new BadRequestException('the upload carried no bytes');
    return this.svc.submit(token, null, { filename: fileName, buffer: Buffer.concat(chunks) });
  }

  /** POST /vendor-portal/:token/decline */
  @Post(':token/decline')
  async decline(@Param('token') token: string, @Body() body: any) {
    return this.svc.decline(token, body?.reason);
  }
}
