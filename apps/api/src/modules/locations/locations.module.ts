import { Module } from '@nestjs/common';
import { PermissionsModule } from '../access/permissions.module';
import {
  BranchesController,
  LocationsController,
  MemberBranchesController,
  SalesChannelsController,
} from './http/locations.controller';
import { LocationsService } from './locations.service';

/** Ubicaciones, sucursales y canales de venta (Fase 6.1; capa L1 de system-overview §4). */
@Module({
  imports: [PermissionsModule],
  controllers: [LocationsController, BranchesController, SalesChannelsController, MemberBranchesController],
  providers: [LocationsService],
})
export class LocationsModule {}
