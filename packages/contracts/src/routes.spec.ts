import {
  CreateRouteRequestSchema,
  PATH_MAX_POINTS,
  UpdateRouteRequestSchema,
  distanceKm,
  inPeru,
  pathLengthKm,
  simplifyPath,
  type LngLat,
} from './routes';

const PUCALLPA = '0190f0a0-0000-7000-8000-000000000001';
const CONTAMANA = '0190f0a0-0000-7000-8000-000000000002';
const IQUITOS = '0190f0a0-0000-7000-8000-000000000003';

const stop = (locationId: string, offsetMinutes: number, over: object = {}) => ({
  locationId,
  offsetMinutes,
  dwellMinutes: 0,
  allowsBoarding: true,
  allowsAlighting: true,
  pathToNext: null,
  ...over,
});
const route = (stops: object[], over: object = {}) => ({
  code: ' pcl-iqt ',
  name: ' Pucallpa – Iquitos ',
  modality: 'RIVER',
  stops,
  ...over,
});
const messages = (input: unknown) => {
  const r = CreateRouteRequestSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('geometría de las trazas (Fase 7.1, F7-Q9)', () => {
  it('distanceKm: un grado de latitud mide ~111,2 km; la distancia es simétrica y 0 en el mismo punto', () => {
    expect(distanceKm([-75, -8], [-75, -9])).toBeCloseTo(111.19, 1);
    expect(distanceKm([-74.5539, -8.3791], [-73.2472, -3.7491])).toBeCloseTo(
      distanceKm([-73.2472, -3.7491], [-74.5539, -8.3791]),
      9,
    );
    expect(distanceKm([-75, -8], [-75, -8])).toBe(0);
  });

  it('pathLengthKm suma los segmentos', () => {
    const path: LngLat[] = [
      [-75, -8],
      [-75, -9],
      [-75, -10],
    ];
    expect(pathLengthKm(path)).toBeCloseTo(2 * distanceKm([-75, -8], [-75, -9]), 9);
    expect(pathLengthKm([[-75, -8]])).toBe(0);
  });

  it('inPeru: Lima e Iquitos dentro; Bogotá, Santiago y La Paz fuera', () => {
    expect(inPeru([-77.0428, -12.0464])).toBe(true);
    expect(inPeru([-73.2472, -3.7491])).toBe(true);
    expect(inPeru([-74.0721, 4.711])).toBe(false);
    expect(inPeru([-70.6693, -33.4489])).toBe(false);
    expect(inPeru([-68.1193, -16.4897])).toBe(false);
  });

  it('simplifyPath conserva una traza corta, quita repetidos seguidos y conserva los extremos', () => {
    const path: LngLat[] = [
      [-75, -8],
      [-75, -8],
      [-75.1, -8.1],
      [-75.2, -8.3],
    ];
    expect(simplifyPath(path)).toEqual([
      [-75, -8],
      [-75.1, -8.1],
      [-75.2, -8.3],
    ]);
  });

  it('simplifyPath reduce una traza densa al máximo, con los extremos y casi el mismo largo', () => {
    // Un meandro de río: 50 000 puntos en zigzag suave.
    const dense: LngLat[] = Array.from({ length: 50_000 }, (_, i) => [
      -75 + i * 0.00004,
      -8 + Math.sin(i / 400) * 0.05,
    ]);
    const simple = simplifyPath(dense);
    expect(simple.length).toBeLessThanOrEqual(PATH_MAX_POINTS);
    expect(simple.length).toBeGreaterThan(100);
    expect(simple[0]).toEqual(dense[0]);
    expect(simple[simple.length - 1]).toEqual(dense[dense.length - 1]);
    expect(pathLengthKm(simple) / pathLengthKm(dense)).toBeGreaterThan(0.99);
    expect(simplifyPath(dense, 10).length).toBeLessThanOrEqual(10);
  });

  it('simplifyPath no se vuelve cuadrático con trazas hostiles (zigzag o recta de 200 000 puntos)', () => {
    const zigzag: LngLat[] = Array.from({ length: 200_000 }, (_, i) => [
      -75 + i * 0.0001,
      -8 + (i % 2) * 0.0001,
    ]);
    const straight: LngLat[] = Array.from({ length: 200_000 }, (_, i) => [-75 + i * 0.00005, -8]);
    const started = Date.now();
    expect(simplifyPath(zigzag).length).toBe(PATH_MAX_POINTS);
    const line = simplifyPath(straight);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(line[0]).toEqual(straight[0]);
    expect(line[line.length - 1]).toEqual(straight[straight.length - 1]);
  });
});

describe('CreateRouteRequestSchema (Fase 7.1)', () => {
  it('normaliza el código y el nombre, y redondea la traza a 6 decimales', () => {
    const parsed = CreateRouteRequestSchema.parse(
      route([
        stop(PUCALLPA, 0, {
          pathToNext: [
            [-74.55391234, -8.37911111],
            [-75.0094, -7.3352],
          ],
        }),
        stop(CONTAMANA, 720, { dwellMinutes: 60 }),
        stop(IQUITOS, 4320),
      ]),
    );
    expect(parsed.code).toBe('PCL-IQT');
    expect(parsed.name).toBe('Pucallpa – Iquitos');
    expect(parsed.stops[0]?.pathToNext?.[0]).toEqual([-74.553912, -8.379111]);
  });

  it('exige origen y destino, origen en 0 minutos y con subida, destino con bajada y sin traza', () => {
    expect(messages(route([stop(PUCALLPA, 0)]))).toContain('Una ruta tiene al menos origen y destino');
    expect(messages(route([stop(PUCALLPA, 5), stop(IQUITOS, 60)]))).toEqual(['El origen tiene 0 minutos']);
    expect(messages(route([stop(PUCALLPA, 0, { allowsBoarding: false }), stop(IQUITOS, 60)]))).toEqual([
      'En el origen se sube',
    ]);
    expect(messages(route([stop(PUCALLPA, 0), stop(IQUITOS, 60, { allowsAlighting: false })]))).toEqual([
      'En el destino se baja',
    ]);
    expect(
      messages(
        route([
          stop(PUCALLPA, 0),
          stop(IQUITOS, 60, {
            pathToNext: [
              [-73.2, -3.7],
              [-73.3, -3.8],
            ],
          }),
        ]),
      ),
    ).toEqual(['El destino no tiene tramo siguiente']);
  });

  it('cada parada llega después de salir de la anterior; dos seguidas no se repiten; las intermedias suben o bajan', () => {
    expect(
      messages(route([stop(PUCALLPA, 0), stop(CONTAMANA, 600, { dwellMinutes: 60 }), stop(IQUITOS, 660)])),
    ).toEqual(['Llega después de salir de la parada anterior']);
    expect(messages(route([stop(PUCALLPA, 0), stop(PUCALLPA, 60)]))).toEqual([
      'Dos paradas seguidas no pueden ser la misma ubicación',
    ]);
    // Ida y vuelta: la misma ubicación, pero no seguidas.
    expect(messages(route([stop(PUCALLPA, 0), stop(CONTAMANA, 600), stop(PUCALLPA, 1200)]))).toEqual([]);
    expect(
      messages(
        route([
          stop(PUCALLPA, 0),
          stop(CONTAMANA, 600, { allowsBoarding: false, allowsAlighting: false }),
          stop(IQUITOS, 1200),
        ]),
      ),
    ).toEqual(['Una parada intermedia permite subir, bajar o ambas']);
  });

  it('rechaza trazas fuera del Perú, de un solo punto o con valores no numéricos, y campos de más', () => {
    const withPath = (pathToNext: unknown) =>
      messages(route([stop(PUCALLPA, 0, { pathToNext }), stop(IQUITOS, 600)]));
    expect(
      withPath([
        [-74.07, 4.71],
        [-73.2, -3.7],
      ]),
    ).toContain('La traza tiene puntos fuera del Perú');
    expect(withPath([[-74.5, -8.3]])).toContain('Una traza tiene al menos 2 puntos');
    expect(
      withPath([
        ['-74.5', -8.3],
        [-73.2, -3.7],
      ]).length,
    ).toBeGreaterThan(0);
    expect(
      withPath([
        [Number.NaN, -8.3],
        [-73.2, -3.7],
      ]).length,
    ).toBeGreaterThan(0);
    expect(messages(route([stop(PUCALLPA, 0), stop(IQUITOS, 60)], { extra: 1 })).length).toBeGreaterThan(0);
    expect(messages(route([stop(PUCALLPA, 0), stop(IQUITOS, 60)], { code: 'x' })).length).toBeGreaterThan(0);
  });

  it('UpdateRouteRequestSchema no admite cambiar el código ni la modalidad', () => {
    const stops = [stop(PUCALLPA, 0), stop(IQUITOS, 60)];
    expect(UpdateRouteRequestSchema.safeParse({ name: 'Nueva', stops }).success).toBe(true);
    expect(UpdateRouteRequestSchema.safeParse({ name: 'Nueva', stops, code: 'OTRA' }).success).toBe(false);
    expect(UpdateRouteRequestSchema.safeParse({ name: 'Nueva', stops, modality: 'LAND' }).success).toBe(
      false,
    );
  });
});
