import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ArgumentsHost, Logger, ValidationPipe } from '@nestjs/common';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

// Crash log so 500s leave a trail we can read after the fact.
//
// The default is anchored to this module, NOT to process.cwd(). It used to be
// pathJoin(process.cwd(), 'apps/api/.api-crash.log'), which is correct only when
// the API is launched from the repository root. Launched from apps/api — which
// is how `npm run start` and .launch-api.ps1 both do it — cwd() is already
// .../apps/api, so the path became .../apps/api/apps/api/.api-crash.log and the
// log silently created a junk tree one directory deeper every run. A path that
// changes with the launch directory is how storage roots get scattered, too.
//
// One `..` from apps/api/{src,dist} lands on apps/api either way, so the file
// sits beside the API package for dev and compiled builds alike.
const CRASH_LOG =
  process.env.API_CRASH_LOG || pathJoin(__dirname, '..', '.api-crash.log');
function logCrash(scope: string, err: unknown) {
  try {
    const dir = CRASH_LOG.replace(/[\\/][^\\/]+$/, '');
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] [${scope}] ${(err as any)?.stack || err}\n`;
    appendFileSync(CRASH_LOG, line);
  } catch { /* ignore */ }
}

async function bootstrap() {
  // Allow-list defaults to the three web ports + 127.0.0.1 variants.
  const defaultOrigins = [
    'http://localhost:33002', 'http://127.0.0.1:33002',
    'http://localhost:33003', 'http://127.0.0.1:33003',
    'http://localhost:33004', 'http://127.0.0.1:33004',
  ];
  const allowed = (process.env.API_CORS_ORIGINS || defaultOrigins.join(','))
    .split(',').map(s => s.trim()).filter(Boolean);

  const app = await NestFactory.create(AppModule, { cors: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  app.enableCors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);            // same-origin / curl / no Origin header
      if (allowed.includes(origin)) return cb(null, true);
      Logger.warn(`CORS reject origin=${origin} allowed=${JSON.stringify(allowed)}`, 'CORS');
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization'],
  });

  // Global filter: log every thrown error to disk.
  app.useGlobalFilters({
    catch(exception: unknown, host: ArgumentsHost) {
      const ctx = host.switchToHttp();
      const req = ctx.getRequest();
      const res = ctx.getResponse();
      const e = exception as any;
      const status = e?.getStatus?.() ?? e?.status ?? 500;
      // Preserve a STRUCTURED response body. The previous extraction took only
      // `e.response.message`, which silently discarded every other key — so an
      // exception carrying per-field detail (e.g. the workflow config validator's
      // `errors` array) reached the client as a bare message and the UI had
      // nothing to show an admin about why a save was refused. String responses
      // behave exactly as before.
      const eo = e?.response;
      const respBody =
        eo && typeof eo === 'object' && !Array.isArray(eo)
          ? eo
          : eo?.message ?? e?.message ?? 'Internal server error';
      const errorTag = e?.response?.error ?? e?.name ?? 'Internal';
      logCrash('exception', e);
      Logger.error(`${req?.method ?? '?'} ${req?.url ?? '?'} -> ${status} ${JSON.stringify(respBody)}`, e?.stack, 'Http');
      const out = typeof respBody === 'string'
        ? { statusCode: status, message: respBody, error: errorTag }
        : { statusCode: status, ...respBody, error: errorTag };
      res.status(status).json(out);
    },
  });

  process.on('unhandledRejection', (r) => logCrash('unhandledRejection', r));
  process.on('uncaughtException', (e) => logCrash('uncaughtException', e));

  const port = Number(process.env.API_PORT || 33001);
  // Node's app.listen(port) already binds to all interfaces; passing a hostname
  // forces a DNS lookup that breaks on Windows when the host is '0.0.0.0'.
  await app.listen(port);
  Logger.log(`Procurement API listening on :${port} (CORS allow=${JSON.stringify(allowed)})`, 'Bootstrap');
}
bootstrap();