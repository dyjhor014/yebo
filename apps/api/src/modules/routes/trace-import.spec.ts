import { PATH_MAX_POINTS, TRACE_FILE_MAX_BYTES } from '@yebo/contracts';
import { AppError } from '../../common/errors/app-error';
import { importTrace } from './trace-import';

const buf = (s: string) => Buffer.from(s, 'utf8');
const fails = (body: unknown): { status: number; message: string } => {
  try {
    importTrace(body);
  } catch (e) {
    if (e instanceof AppError) return { status: e.httpStatus, message: e.message };
    throw e;
  }
  throw new Error('importTrace no falló');
};

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<!-- grabado en la lancha -->
<gpx version="1.1" creator="prueba" xmlns="http://www.topografix.com/GPX/1/1">
  <wpt lat="-8.3791" lon="-74.5539"><name>Puerto Pucallpa</name></wpt>
  <trk><name>Pucallpa - Contamana</name>
    <trkseg>
      <trkpt lat="-8.3791" lon="-74.5539"><ele>150</ele><time>2026-11-01T06:00:00Z</time></trkpt>
      <trkpt lon='-74.70' lat='-8.00'/>
    </trkseg>
    <trkseg>
      <trkpt lat="-7.6" lon="-74.9"></trkpt>
      <trkpt lat="-7.3352" lon="-75.0094"></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <Placemark><name>Contamana</name><Point><coordinates>-75.0094,-7.3352,0</coordinates></Point></Placemark>
    <Placemark><name>Río</name>
      <LineString><tessellate>1</tessellate>
        <coordinates>
          -75.0094,-7.3352,0 -75.3,-6.9,0
          -75.8,-6.3
        </coordinates>
      </LineString>
    </Placemark>
    <Placemark><gx:Track><when>2026-11-02T06:00:00Z</when>
      <gx:coord>-76.0 -6.0 120</gx:coord><gx:coord>-76.0911 -5.8984 120</gx:coord>
    </gx:Track></Placemark>
  </Document>
</kml>`;

describe('importTrace (Fase 7.1, F7-Q9)', () => {
  it('GPX: une los segmentos de las pistas en orden e ignora los waypoints', () => {
    const r = importTrace(buf(GPX));
    expect(r.format).toBe('GPX');
    expect(r.sourcePoints).toBe(4);
    expect(r.points).toEqual([
      [-74.5539, -8.3791],
      [-74.7, -8],
      [-74.9, -7.6],
      [-75.0094, -7.3352],
    ]);
    expect(r.km).toBeGreaterThan(120);
    expect(r.km).toBeLessThan(140);
  });

  it('GPX sin pista: usa los puntos de la ruta (rtept)', () => {
    const r = importTrace(
      buf(`<gpx><rte><rtept lat="-8.38" lon="-74.55"/><rtept lat="-7.34" lon="-75.01"/></rte></gpx>`),
    );
    expect(r.points).toEqual([
      [-74.55, -8.38],
      [-75.01, -7.34],
    ]);
  });

  it('KML: líneas y pistas gx:Track en orden; los puntos sueltos no son traza', () => {
    const r = importTrace(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf(KML)])); // con BOM;
    expect(r.format).toBe('KML');
    expect(r.points).toEqual([
      [-75.0094, -7.3352],
      [-75.3, -6.9],
      [-75.8, -6.3],
      [-76, -6],
      [-76.0911, -5.8984],
    ]);
  });

  it('simplifica una pista densa a PATH_MAX_POINTS', () => {
    const points = Array.from(
      { length: 20_000 },
      (_, i) =>
        `<trkpt lat="${(-8 + Math.sin(i / 300) * 0.05).toFixed(6)}" lon="${(-75 + i * 0.0002).toFixed(6)}"/>`,
    );
    const r = importTrace(buf(`<gpx><trk><trkseg>${points.join('')}</trkseg></trk></gpx>`));
    expect(r.sourcePoints).toBe(20_000);
    expect(r.points.length).toBe(PATH_MAX_POINTS);
  });

  it('rechaza DOCTYPE y entidades (XXE, «mil millones de risas»)', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY x SYSTEM "file:///etc/passwd">]><gpx>&x;</gpx>`;
    expect(fails(buf(xxe))).toEqual({
      status: 400,
      message: 'El archivo declara un DOCTYPE o entidades, y no se admiten',
    });
    const lol = `<?xml version="1.0"?><!ENTITY lol "lol"><kml>&lol;</kml>`;
    expect(fails(buf(lol)).status).toBe(400);
  });

  it('rechaza lo que no es GPX ni KML, sin pista, fuera del Perú, no numérico, no UTF-8, vacío o enorme', () => {
    expect(fails(buf('<svg><path d="M0 0"/></svg>')).message).toBe('El archivo no es un GPX ni un KML');
    expect(fails(buf('hola')).message).toBe('El archivo no es un GPX ni un KML');
    expect(fails(buf('<gpx><wpt lat="-8" lon="-75"/></gpx>')).message).toBe(
      'El GPX no trae una pista ni una ruta con al menos 2 puntos',
    );
    expect(fails(buf('<kml><Point><coordinates>-75,-8</coordinates></Point></kml>')).message).toBe(
      'El KML no trae una línea con al menos 2 puntos',
    );
    expect(
      fails(buf('<gpx><trk><trkpt lat="4.71" lon="-74.07"/><trkpt lat="-8" lon="-75"/></trk></gpx>')).message,
    ).toBe('Un punto está fuera del Perú: revisa el archivo');
    expect(
      fails(buf('<gpx><trk><trkpt lat="abc" lon="-75"/><trkpt lat="-8" lon="-75"/></trk></gpx>')).message,
    ).toBe('Hay una latitud que no es un número');
    expect(fails(buf('<gpx><trk><trkpt lon="-75"/><trkpt lat="-8" lon="-75"/></trk></gpx>')).message).toBe(
      'Hay una latitud que no es un número',
    );
    expect(fails(Buffer.from([0x3c, 0x67, 0x70, 0x78, 0xff, 0xfe, 0x3e])).message).toBe(
      'El archivo no está en UTF-8',
    );
    expect(fails(Buffer.alloc(0)).status).toBe(400);
    expect(fails({ gpx: true }).status).toBe(400);
    expect(fails(Buffer.alloc(TRACE_FILE_MAX_BYTES + 1, 0x20)).status).toBe(413);
  });

  it('rechaza etiquetas, comentarios e instrucciones sin cerrar', () => {
    expect(fails(buf('<gpx><trk><trkpt lat="-8" lon="-75"')).message).toBe(
      'El archivo tiene una etiqueta sin cerrar',
    );
    expect(fails(buf('<gpx><!-- sin cerrar')).message).toBe('El archivo tiene un comentario sin cerrar');
    expect(fails(buf('<?xml version="1.0"')).message).toBe('El archivo tiene una instrucción sin cerrar');
  });

  it('un archivo hostil de casi 5 MB se resuelve rápido (sin retroceso cuadrático)', () => {
    const size = TRACE_FILE_MAX_BYTES - 1024;
    const hostile = [
      `<gpx>${'<!--'.repeat(size / 4)}`,
      `<gpx>${'<a '.repeat(size / 3)}`,
      `<gpx>${'<trkpt lat="-8" lon="-75 '.repeat(size / 26)}`,
      `<kml><LineString><coordinates>${'-75,-8 '.repeat(size / 7)}`,
    ];
    for (const body of hostile) {
      const started = Date.now();
      try {
        importTrace(buf(body.slice(0, size)));
      } catch {
        // Puede fallar (es lo esperado); lo que se mide es el tiempo.
      }
      expect(Date.now() - started).toBeLessThan(3000);
    }
  });
});
