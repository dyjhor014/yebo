import { Module } from '@nestjs/common';
import { PermissionsModule } from '../access/permissions.module';
import { FaresController } from './http/fares.controller';
import { FaresService } from './fares.service';

/** Tarifas de las rutas por par, servicio y clase de precio, con vigencia (Fase 7.2; F7-Q1). */
@Module({
  imports: [PermissionsModule],
  controllers: [FaresController],
  providers: [FaresService],
})
export class FaresModule {}
