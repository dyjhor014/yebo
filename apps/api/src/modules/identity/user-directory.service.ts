import { Injectable } from '@nestjs/common';
import { IdentityPrismaService } from './identity-prisma.service';

export interface UserSummary {
  email: string;
  fullName: string;
}

/**
 * Datos visibles de las personas (correo y nombre) para la gestión de accesos de una empresa. Lectura de `users`
 * con `yebo_identity`: `yebo_app` no tiene acceso a esa tabla (contiene el hash de la contraseña). Quien llama
 * pasa SOLO ids de membresías de su propio tenant; este servicio nunca expone el hash ni el estado global.
 */
@Injectable()
export class UserDirectoryService {
  constructor(private readonly db: IdentityPrismaService) {}

  async describe(userIds: readonly string[]): Promise<Map<string, UserSummary>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.db.client.user.findMany({
      where: { id: { in: [...new Set(userIds)] } },
      select: { id: true, email: true, fullName: true },
    });
    return new Map(rows.map((r) => [r.id, { email: r.email, fullName: r.fullName }]));
  }
}
