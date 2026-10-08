import { Global, Module } from '@nestjs/common';
import { DbService } from './db.service';
import { PG_POOL } from './db.tokens';

@Global()
@Module({
  // PG_POOL is exported for backward-compat with services that may inject it,
  // but the live implementation uses child_process+docker exec via DbService.
  providers: [
    {
      provide: PG_POOL,
      useValue: null,
    },
    DbService,
  ],
  exports: [PG_POOL, DbService],
})
export class DbModule {}
