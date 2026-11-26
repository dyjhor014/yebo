'use client';

/**
 * Ubigeos del INEI (departamento, provincia y distrito) para elegir la ubicación de la empresa (Fase 6.4b). El
 * catálogo es estático (`/datos/ubigeo-inei.json`, unos 30 KB comprimido) y se pide solo cuando hace falta; la
 * fuente y su licencia están en `/datos/ubigeo-inei.LICENSE.txt`. El código del distrito es el ubigeo (6 dígitos):
 * sus 2 primeros dígitos son el departamento y los 4 primeros, la provincia.
 */
export type District = { code: string; name: string; lat: number | null; lng: number | null };
export type UbigeoCatalog = {
  departments: { code: string; name: string }[];
  provinces: { code: string; name: string }[];
  districts: District[];
  byCode: Map<string, District>;
};

let cache: Promise<UbigeoCatalog> | null = null;

export function loadUbigeo(): Promise<UbigeoCatalog> {
  cache ??= fetch('/datos/ubigeo-inei.json', { cache: 'force-cache' })
    .then((r) => {
      if (!r.ok) throw new Error('No se pudo cargar el catálogo de ubigeos');
      return r.json() as Promise<{
        departamentos: [string, string][];
        provincias: [string, string][];
        distritos: [string, string, number | null, number | null][];
      }>;
    })
    .then((d) => {
      const districts = d.distritos.map(([code, name, lat, lng]) => ({ code, name, lat, lng }));
      return {
        departments: d.departamentos.map(([code, name]) => ({ code, name })),
        provinces: d.provincias.map(([code, name]) => ({ code, name })),
        districts,
        byCode: new Map(districts.map((x) => [x.code, x])),
      };
    })
    .catch((e: unknown) => {
      cache = null;
      throw e;
    });
  return cache;
}

/** «Calleria · Coronel Portillo · Ucayali» a partir del ubigeo, o null si no está en el catálogo. */
export function ubigeoLabel(cat: UbigeoCatalog, ubigeo: string | null): string | null {
  if (!ubigeo) return null;
  const d = cat.byCode.get(ubigeo);
  if (!d) return null;
  const p = cat.provinces.find((x) => x.code === ubigeo.slice(0, 4));
  const r = cat.departments.find((x) => x.code === ubigeo.slice(0, 2));
  return [d.name, p?.name, r?.name].filter(Boolean).join(' · ');
}
