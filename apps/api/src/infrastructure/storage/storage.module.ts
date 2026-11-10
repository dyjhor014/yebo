import { Global, Module } from '@nestjs/common';
import { ObjectStorage, S3ObjectStorage } from './object-storage';

/** Almacenamiento de objetos para toda la API (Fase 5.2). Las pruebas pueden sustituir ObjectStorage. */
@Global()
@Module({
  providers: [{ provide: ObjectStorage, useClass: S3ObjectStorage }],
  exports: [ObjectStorage],
})
export class StorageModule {}
