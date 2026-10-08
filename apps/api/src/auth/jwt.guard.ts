import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AuthService, AuthenticatedUser } from './auth.service';

declare module 'express' {
  interface Request {
    user?: AuthenticatedUser;
  }
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const auth = (req.headers['authorization'] || req.headers['Authorization']) as string | undefined;
    if (!auth || !auth.toLowerCase().startsWith('bearer ')) return false;
    const token = auth.slice(7).trim();
    const user = await this.auth.verify(token);
    req.user = user;
    return true;
  }
}
