import { Global, Module } from '@nestjs/common';
import { AppPrismaService } from './app-prisma.service';
import { PlatformPrismaService } from './platform-prisma.service';
import { TenantDbService } from './tenant-db.service';

@Global()
@Module({
  providers: [AppPrismaService, PlatformPrismaService, TenantDbService],
  exports: [AppPrismaService, PlatformPrismaService, TenantDbService],
})
export class DatabaseModule {}
